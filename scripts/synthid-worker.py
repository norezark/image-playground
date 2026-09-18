"""Run the pinned local remover; never call a generation or verification API."""
import importlib.metadata
import json
import sys
from pathlib import Path

VERSION = "0.41.1"


def check_runtime():
    version = importlib.metadata.version("remove-ai-watermarks")
    if version != VERSION:
        raise RuntimeError(f"remove-ai-watermarks {VERSION} is required (found {version})")
    try:
        import google.protobuf  # noqa: F401
        import sentencepiece  # noqa: F401
    except ImportError as error:
        raise RuntimeError("SynthID前処理の依存ライブラリが不足しています。scripts/setup-synthid.ps1 を再実行してください。") from error
    import torch
    import diffsynth  # noqa: F401
    from remove_ai_watermarks.cli import main  # noqa: F401

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA-enabled PyTorch and an NVIDIA GPU are required")
    return {"available": True, "version": version, "device": torch.cuda.get_device_name(0)}


def enable_chroma_offload(work_dir):
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
            CHROMA_MODEL_ID, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True, **token)
        for name, component in pipe.components.items():
            if isinstance(component, torch.nn.Module):
                apply_group_offloading(
                    component, onload_device=torch.device(self.device),
                    offload_device=torch.device("cpu"), offload_type="leaf_level",
                    use_stream=False, offload_to_disk_path=str(work_dir / "offload" / name))
        self._chroma_pipe = pipe
        return pipe

    ChromaZImagePipeline._load_global = load_global


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
