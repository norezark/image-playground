"""Run the pinned local remover; never call a generation or verification API."""
import gc
import hashlib
import importlib.metadata
import os
import pickle
import json
import sys
from pathlib import Path

VERSION = "0.41.1"
BNB_VERSION = "0.50.2"
DIFFSYNTH_VERSION = "2.1.7"
CHROMA_REVISION = "0e0c60ece1e82b17cb7f77342d765ba5024c40c0"


def chroma_precision():
    precision = os.environ.get("SYNTHID_CHROMA_PRECISION", "nf4")
    if precision not in ("nf4", "bf16"):
        raise RuntimeError("SYNTHID_CHROMA_PRECISION must be nf4 or bf16")
    return precision


def qwen_precision():
    precision = os.environ.get("SYNTHID_QWEN_PRECISION", "nf4")
    if precision not in ("nf4", "fp8"):
        raise RuntimeError("SYNTHID_QWEN_PRECISION must be nf4 or fp8")
    return precision


def check_runtime():
    version = importlib.metadata.version("remove-ai-watermarks")
    if version != VERSION:
        raise RuntimeError(f"remove-ai-watermarks {VERSION} is required (found {version})")
    try:
        import google.protobuf  # noqa: F401
        import sentencepiece  # noqa: F401
    except ImportError as error:
        raise RuntimeError("SynthID前処理の依存ライブラリが不足しています。scripts/setup-synthid.ps1 を再実行してください。") from error
    if importlib.metadata.version('diffsynth') != DIFFSYNTH_VERSION:
        raise RuntimeError(f"diffsynth {DIFFSYNTH_VERSION} is required: scripts/setup-synthid.ps1")
    if "nf4" in (chroma_precision(), qwen_precision()):
        try:
            import bitsandbytes
            if bitsandbytes.__version__ != BNB_VERSION:
                raise RuntimeError(f"bitsandbytes {BNB_VERSION} is required")
        except (ImportError, RuntimeError) as error:
            raise RuntimeError("4bit前処理の依存関係を更新してください: scripts/setup-synthid.ps1") from error
    import torch
    import diffsynth  # noqa: F401
    from remove_ai_watermarks.cli import main  # noqa: F401

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA-enabled PyTorch and an NVIDIA GPU are required")
    return {"available": True, "version": version, "device": torch.cuda.get_device_name(0),
            "chromaPrecision": chroma_precision(), "qwenPrecision": qwen_precision()}


def _enable_chroma_bf16(work_dir):
    """Adapt the pinned engine's Chroma loader, whose --cpu-offload is a no-op.

    Preserve the upstream global pass, prompt, strengths and face stage. Only
    change where model weights live; never move the entire pipeline to CUDA.
    Temporary offload weights are covered by the Node worker's job cleanup.
    """
    from remove_ai_watermarks._internal.chroma_zimage_pipeline import ChromaZImagePipeline, CHROMA_MODEL_ID

    def load_global(self):
        if self._chroma_pipe is not None:
            return self._chroma_pipe
        self._require_cuda()
        import torch
        from diffusers import ChromaImg2ImgPipeline
        from diffusers.hooks import apply_group_offloading

        self._progress("Loading Chroma1-HD with disk/CPU offload...")
        token = {"token": self.hf_token} if self.hf_token else {}
        pipe = ChromaImg2ImgPipeline.from_pretrained(
            CHROMA_MODEL_ID, revision=CHROMA_REVISION, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True, **token)
        for name, component in pipe.components.items():
            if isinstance(component, torch.nn.Module):
                apply_group_offloading(
                    component, onload_device=torch.device(self.device),
                    offload_device=torch.device("cpu"), offload_type="leaf_level",
                    use_stream=False, offload_to_disk_path=str(work_dir / "offload" / name))
        self._chroma_pipe = pipe
        return pipe

    ChromaZImagePipeline._load_global = load_global


def _enable_chroma_nf4(work_dir):
    """Cache BF16 prompt embeddings and mixed NF4/BF16 model weights."""
    from remove_ai_watermarks._internal.chroma_zimage_pipeline import (
        ChromaZImagePipeline, CHROMA_MODEL_ID, CHROMA_PROMPT, CHROMA_NEGATIVE)
    from remove_ai_watermarks._internal.two_stage_pipeline import _store_prompt_payload

    cache_root = Path(os.environ.get('HF_HOME', Path(__file__).resolve().parents[1] / '.synthid/models')) / 'image-playground'
    recipe = [CHROMA_MODEL_ID, CHROMA_REVISION, CHROMA_PROMPT, CHROMA_NEGATIVE,
              importlib.metadata.version('transformers'), importlib.metadata.version('diffusers'), 'bf16-v1']
    prompt_key = hashlib.sha256(json.dumps(recipe).encode()).hexdigest()[:32]
    prompt_path = cache_root / ('chroma-prompt-' + prompt_key + '.pt')
    # Change the suffix whenever the quantization settings below change.
    model_path = cache_root / f'chroma-{CHROMA_REVISION[:12]}-nf4-double-bnb-{BNB_VERSION}-v2'

    def prompt_embeddings(self, source):
        import torch
        from diffusers import ChromaImg2ImgPipeline
        from diffusers.hooks import apply_group_offloading
        from transformers import T5EncoderModel

        keys = {'prompt_embeds', 'negative_prompt_embeds', 'prompt_attention_mask', 'negative_prompt_attention_mask'}
        payload = None
        if prompt_path.is_file():
            try:
                payload = torch.load(prompt_path, map_location='cpu', weights_only=True)
                if not isinstance(payload, dict) or set(payload) != keys:
                    raise ValueError('Invalid prompt cache')
                for key, value in payload.items():
                    shape = (1, 512) if key.endswith('mask') else (1, 512, 4096)
                    if not isinstance(value, torch.Tensor) or tuple(value.shape) != shape or not torch.isfinite(value).all():
                        raise ValueError('Invalid prompt tensor')
                self._progress('Loading cached Chroma1 prompt embeddings...')
            except (OSError, RuntimeError, ValueError, EOFError, TypeError, pickle.UnpicklingError):
                payload = None
        if payload is None:
            self._progress('Preparing Chroma1 prompt embeddings (first use only)...')
            token = {'token': self.hf_token} if self.hf_token else {}
            encoder = T5EncoderModel.from_pretrained(source, subfolder='text_encoder',
                revision=CHROMA_REVISION, dtype=torch.bfloat16, low_cpu_mem_usage=True, **token)
            apply_group_offloading(encoder, onload_device=torch.device(self.device),
                offload_device=torch.device('cpu'), offload_type='block_level', num_blocks_per_group=1)
            prompt_pipe = ChromaImg2ImgPipeline.from_pretrained(source,
                text_encoder=encoder, transformer=None, vae=None, torch_dtype=torch.bfloat16, **token)
            with torch.inference_mode():
                positive, _, positive_mask, negative, _, negative_mask = prompt_pipe.encode_prompt(
                    prompt=CHROMA_PROMPT, negative_prompt=CHROMA_NEGATIVE,
                    device=torch.device(self.device), do_classifier_free_guidance=True)
            payload = dict(prompt_embeds=positive.cpu(), negative_prompt_embeds=negative.cpu(),
                prompt_attention_mask=positive_mask.cpu(), negative_prompt_attention_mask=negative_mask.cpu())
            _store_prompt_payload(prompt_path, payload)
            del prompt_pipe, encoder, positive, negative, positive_mask, negative_mask
            gc.collect()
            torch.cuda.empty_cache()
        return {key: value.to(device=self.device, dtype=torch.bfloat16) for key, value in payload.items()}

    def load_global(self):
        import torch
        from diffusers import ChromaImg2ImgPipeline, ChromaTransformer2DModel, BitsAndBytesConfig

        self._require_cuda()
        if self._chroma_pipe is not None:
            self._chroma_pipe.transformer.to(self.device)
            self._chroma_pipe.vae.to(self.device)
            return self._chroma_pipe
        token = {'token': self.hf_token} if self.hf_token else {}
        # Resolve the complete snapshot once; warm runs need no Hub requests.
        try:
            source = ChromaImg2ImgPipeline.download(CHROMA_MODEL_ID, revision=CHROMA_REVISION,
                local_files_only=True, **token)
        except OSError:
            source = ChromaImg2ImgPipeline.download(CHROMA_MODEL_ID, revision=CHROMA_REVISION, **token)
        self._chroma_embeds = prompt_embeddings(self, source)
        self._chroma_t5_freed = True
        if model_path.is_dir():
            self._progress('Loading cached Chroma1-HD NF4 model...')
            transformer = ChromaTransformer2DModel.from_pretrained(model_path,
                torch_dtype=torch.bfloat16, device_map={'': self.device}, local_files_only=True)
        else:
            self._progress('Quantizing Chroma1-HD to NF4 (first use only)...')
            # Quantizing these conditioning layers visibly distorts text and edges.
            config = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
                llm_int8_skip_modules=['distilled_guidance_layer', 'x_embedder', 'context_embedder'])
            transformer = ChromaTransformer2DModel.from_pretrained(source,
                subfolder='transformer', revision=CHROMA_REVISION, torch_dtype=torch.bfloat16,
                quantization_config=config, device_map={'': self.device}, **token)
            temporary = Path(work_dir) / 'quantized-chroma'
            transformer.save_pretrained(temporary, max_shard_size='2GB')
            model_path.parent.mkdir(parents=True, exist_ok=True)
            temporary.rename(model_path)
        self._progress('Running Chroma1-HD with NF4 weights...')
        pipe = ChromaImg2ImgPipeline.from_pretrained(source,
            transformer=transformer, text_encoder=None, torch_dtype=torch.bfloat16, **token)
        pipe.vae.to(self.device)
        self._chroma_pipe = pipe
        return pipe

    run_global = ChromaZImagePipeline._run_global

    def run_and_release(self, image, strength, seed):
        try:
            return run_global(self, image, strength, seed)
        finally:
            # Release the global model before the separate face-repair stage.
            if self._chroma_pipe is not None:
                import torch
                self._chroma_pipe.transformer.to('cpu')
                self._chroma_pipe.vae.to('cpu')
                torch.cuda.empty_cache()

    ChromaZImagePipeline._load_global = load_global
    ChromaZImagePipeline._run_global = run_and_release

    face_vram_config = ChromaZImagePipeline._zimage_vram_config

    def cpu_face_weights():
        # DiffSynth otherwise retains visited layers on CUDA and can exhaust
        # VRAM during face repair, even though --cpu-offload was requested.
        config = face_vram_config()
        config['preparing_device'] = 'cpu'
        return config

    ChromaZImagePipeline._zimage_vram_config = staticmethod(cpu_face_weights)


def enable_chroma_offload(work_dir):
    if chroma_precision() == "nf4":
        _enable_chroma_nf4(work_dir)
    else:
        _enable_chroma_bf16(work_dir)


def run():
    if sys.argv[1:] == ["--check"]:
        print(json.dumps(check_runtime(), ensure_ascii=False))
        return
    if len(sys.argv) != 3:
        raise RuntimeError("Expected an input file and a separate output PNG")
    source, destination = sys.argv[1:]
    check_runtime()
    from PIL import Image
    from remove_ai_watermarks.cli import main

    if Path(source).resolve() == Path(destination).resolve():
        raise RuntimeError("The original image must not be overwritten")
    with Image.open(source) as image:
        original_size = image.size
        image.verify()
    enable_chroma_offload(Path(destination).resolve().parent)
    from synthid_qwen import enable as enable_qwen
    enable_qwen(Path(destination).resolve().parent, qwen_precision())
    # Auto selects the profile/strength from INPUT provenance, not the model
    # selected for the following edit. Force also handles stripped metadata.
    main(args=["invisible", source, "-o", destination, "--pipeline", "auto",
               "--force", "--cpu-offload", "--max-resolution", "0",
               "--seed", "0", "--humanize", "0", "--unsharp", "0"],
         standalone_mode=False)
    with Image.open(destination) as image:
        if image.format != "PNG" or image.size != original_size:
            raise RuntimeError("The remover must return a PNG at the original resolution")
        image.verify()
    # Process completion is not a watermark detection verdict.
    print(json.dumps({"processed": True, "verification": "unverified"}))


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        print(f"SynthID preprocessing failed: {error}", file=sys.stderr)
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
    except SystemExit as error:
        if error.code:
            # Click wraps model errors in SystemExit; its error line goes to
            # stdout while progress goes to stderr. Preserve the actual cause.
            cause = error.__cause__
            if cause is not None:
                print(json.dumps({"error": str(cause)}, ensure_ascii=False))
        raise
