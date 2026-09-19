"""Cached NF4 Qwen weights with the pinned DiffSynth pipeline and CPU offload."""
import gc
import hashlib
import importlib.metadata
import json
import os
import re
from pathlib import Path

EXCLUDE = ['img_mod.1', 'txt_mod.1', 'norm_out.linear', 'img_in', 'txt_in',
           'proj_out', 'time_text_embed.timestep_embedder.linear_1',
           'time_text_embed.timestep_embedder.linear_2']


def prepare_weights(paths, cache_root, work_dir, progress):
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file
    from diffsynth.core.quant import QuantizeConfig
    from diffsynth.models.qwen_image_dit import QwenImageDiT
    from diffsynth.core.loader import hash_model_file

    recipe = {'files': [(Path(p).name, Path(p).stat().st_size, Path(p).stat().st_mtime_ns) for p in paths],
              'exclude': EXCLUDE, 'bnb': importlib.metadata.version('bitsandbytes'),
              'diffsynth': importlib.metadata.version('diffsynth'), 'format': 'nf4-fp8mod-v1'}
    key = hashlib.sha256(json.dumps(recipe, sort_keys=True).encode()).hexdigest()[:24]
    destination = Path(cache_root) / ('qwen-2512-' + key)
    manifest_path = destination / 'manifest.json'
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if not manifest['files'] or any(not re.fullmatch(r'model-\d{3}\.safetensors', f['name']) for f in manifest['files']):
            raise RuntimeError(f'Invalid Qwen NF4 cache manifest: {manifest_path}')
        files = [str(destination / f['name']) for f in manifest['files']]
        if all(Path(p).is_file() and Path(p).stat().st_size == f['bytes'] for p, f in zip(files, manifest['files'])):
            progress('Loading cached Qwen NF4 weights...')
            return files, manifest['model_hash']
    if destination.exists():
        raise RuntimeError(f'Qwen NF4 model cache is incomplete: {destination}')

    progress('Quantizing Qwen to NF4 one layer at a time (first use only)...')
    temporary = Path(work_dir) / 'quantized-qwen'
    temporary.mkdir(parents=True, exist_ok=True)
    with torch.device('meta'):
        skeleton = QwenImageDiT()
    quant = QuantizeConfig(method='bitsandbytes_nf4', exclude_modules=EXCLUDE)
    targeted = {name for name, module in skeleton.named_modules() if quant._should_quantize(name, module)}
    del skeleton
    tensors, written, shard_bytes, converted = {}, [], 0, 0

    def flush():
        nonlocal tensors, shard_bytes
        if not tensors:
            return
        name = f'model-{len(written):03d}.safetensors'
        save_file(tensors, str(temporary / name), metadata={'format': 'pt'})
        written.append(name)
        tensors, shard_bytes = {}, 0

    for source in paths:
        with safe_open(str(source), framework='pt', device='cpu') as checkpoint:
            for name in checkpoint.keys():
                value = checkpoint.get_tensor(name)
                layer_name = name.removesuffix('.weight')
                if name.endswith('.weight') and layer_name in targeted:
                    layer = torch.nn.Linear(value.shape[1], value.shape[0], bias=False, device='meta', dtype=torch.bfloat16)
                    layer.weight = torch.nn.Parameter(value.to(torch.bfloat16), requires_grad=False)
                    packed = quant.backend.create_quantized_linear(layer, compute_device='cuda', model_device='cpu')
                    values = {layer_name + '.' + k: v.contiguous() for k, v in packed.state_dict().items()}
                    converted += 1
                    del layer, packed
                    if converted % 60 == 0:
                        progress(f'Quantizing Qwen: {converted}/{len(targeted)} layers...')
                else:
                    # Match the existing pipeline's FP8 storage for conditioning,
                    # norms and biases, which are computed in BF16 at runtime.
                    values = {name: value.to(torch.float8_e4m3fn).contiguous()}
                tensors.update(values)
                shard_bytes += sum(v.numel() * v.element_size() for v in values.values())
                del value, values
                if shard_bytes >= 1024**3:
                    flush()
    flush()
    if converted != len(targeted):
        raise RuntimeError(f'Incomplete quantization: {converted}/{len(targeted)} layers')
    files = [str(temporary / name) for name in written]
    model_hash = hash_model_file(files)
    manifest = {'model_hash': model_hash, 'files': [{'name': name, 'bytes': (temporary/name).stat().st_size} for name in written]}
    (temporary / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary.rename(destination)
    gc.collect()
    torch.cuda.empty_cache()
    return [str(destination/name) for name in written], model_hash


def enable(work_dir, precision='nf4'):
    import torch
    from diffsynth.configs import MODEL_CONFIGS
    from diffsynth.core.quant import QuantizeConfig
    from diffsynth.pipelines.qwen_image import ModelConfig, QwenImagePipeline, ControlNetInput
    from diffsynth.diffusion import FlowMatchScheduler
    from remove_ai_watermarks._internal.qwen_zimage_pipeline import (
        QwenZImagePipeline, QWEN_IMAGE_2512_MODEL_ID, QWEN_CANNY_CONTROLNET_MODEL_ID,
        QWEN_LIGHTNING_MODEL_ID, QWEN_LIGHTNING_PATTERN, _QWEN_PROMPT_OUTPUTS, _GLOBAL_PROMPT)
    from remove_ai_watermarks._internal.two_stage_pipeline import _cache_static_prompt_embeddings
    os.environ.setdefault('DIFFSYNTH_DOWNLOAD_SOURCE', 'huggingface')

    def local_config(model_id, pattern, **kwargs):
        base = Path(os.environ['DIFFSYNTH_MODEL_BASE_PATH']) / model_id
        files = sorted(base.glob(pattern.rstrip('/') + ('/*' if pattern.endswith('/') else '')))
        complete = bool(files)
        shards = [re.search(r'-(\d+)-of-(\d+)\.safetensors$', p.name) for p in files]
        if complete and all(shards):
            total = int(shards[0][2])
            complete = all(int(s[2]) == total for s in shards) and {int(s[1]) for s in shards} == set(range(1, total + 1))
        if pattern.endswith('/'):
            complete = all((base/pattern/name).is_file() for name in ['tokenizer_config.json', 'vocab.json', 'merges.txt'])
        if complete:
            path = str(base/pattern) if pattern.endswith('/') else [str(p) for p in files]
            if isinstance(path, list) and len(path) == 1:
                path = path[0]
            return ModelConfig(path=path, **kwargs)
        return ModelConfig(model_id=model_id, origin_file_pattern=pattern, **kwargs)

    def load_global(self):
        if self._qwen_pipe is not None:
            return self._qwen_pipe
        self._require_cuda()
        source = local_config(QWEN_IMAGE_2512_MODEL_ID, 'transformer/diffusion_pytorch_model*.safetensors')
        source.download_if_necessary()
        paths = source.path if isinstance(source.path, list) else [source.path]
        # Packed weights remain in RAM during a pass; only the current layer is
        # copied to CUDA. Do not grow GPU residency as each layer is visited.
        config = dict(offload_dtype='disk', offload_device='disk',
                      onload_dtype=torch.float8_e4m3fn, onload_device='cpu',
                      preparing_dtype=torch.float8_e4m3fn, preparing_device='cpu',
                      computation_dtype=torch.bfloat16, computation_device=self.device)
        if precision == 'nf4':
            cache_root = Path(os.environ['HF_HOME']) / 'image-playground'
            quantized, model_hash = prepare_weights(paths, cache_root, work_dir, self._progress)
            if not any(c['model_hash'] == model_hash for c in MODEL_CONFIGS):
                MODEL_CONFIGS.append({'model_hash': model_hash, 'model_name': 'qwen_image_dit',
                                     'model_class': 'diffsynth.models.qwen_image_dit.QwenImageDiT'})
            transformer = ModelConfig(path=quantized, quantize=QuantizeConfig(method='bitsandbytes_nf4',
                exclude_modules=EXCLUDE, load_prequantized=True), **config)
        else:
            transformer = ModelConfig(path=paths, **config)
        cached_prompt = self._prompt_is_cached(QWEN_IMAGE_2512_MODEL_ID, _QWEN_PROMPT_OUTPUTS, _GLOBAL_PROMPT)
        configs = [transformer,
                   local_config(QWEN_IMAGE_2512_MODEL_ID, 'vae/diffusion_pytorch_model.safetensors', **config),
                   local_config(QWEN_CANNY_CONTROLNET_MODEL_ID, 'model.safetensors', **config)]
        if not cached_prompt:
            configs.append(local_config(QWEN_IMAGE_2512_MODEL_ID, 'text_encoder/model*.safetensors', **config))
        self._progress(f'Loading Qwen {precision.upper()} pipeline...')
        pipe = QwenImagePipeline.from_pretrained(torch_dtype=self.torch_dtype, device=self.device,
            model_configs=configs, tokenizer_config=local_config(QWEN_IMAGE_2512_MODEL_ID, 'tokenizer/'),
            vram_limit=self._vram_limit())
        pipe.scheduler = FlowMatchScheduler('Qwen-Image-Lightning')
        pipe.load_lora(pipe.dit, local_config(QWEN_LIGHTNING_MODEL_ID, QWEN_LIGHTNING_PATTERN), alpha=0.8)
        _cache_static_prompt_embeddings(pipe, _QWEN_PROMPT_OUTPUTS, model_id=QWEN_IMAGE_2512_MODEL_ID, require_cache=cached_prompt)
        self._qwen_pipe = (pipe, ControlNetInput)
        return self._qwen_pipe

    QwenZImagePipeline._load_global = load_global
    face_config = QwenZImagePipeline._zimage_vram_config
    def cpu_face_weights():
        return {**face_config(), 'preparing_device': 'cpu'}
    QwenZImagePipeline._zimage_vram_config = staticmethod(cpu_face_weights)
