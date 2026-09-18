# Installs only the optional local preprocessing runtime, inside this project.
param([string]$Python = '3.12')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.synthid'
$cachePath = Join-Path $runtimeRoot 'uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot 'python'
$venvPath = Join-Path $runtimeRoot 'venv'
$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is required: https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Path -LiteralPath $pythonPath)) {
    & uv --cache-dir $cachePath venv --python $Python $venvPath
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the SynthID Python environment.' }
}
# Install CUDA wheels explicitly; do not modify any existing Python environment.
& uv --cache-dir $cachePath pip install --python $pythonPath torch torchvision --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw 'Unable to install CUDA PyTorch.' }
& uv --cache-dir $cachePath pip install --python $pythonPath 'remove-ai-watermarks[qwen-zimage]==0.41.1' 'protobuf>=3.20.3,<7'
if ($LASTEXITCODE -ne 0) { throw 'Unable to install the SynthID remover.' }
$env:PYTHON_DOTENV_DISABLED = '1'
$env:PYTHONUTF8 = '1'
& $pythonPath (Join-Path $PSScriptRoot 'synthid-worker.py') --check
if ($LASTEXITCODE -ne 0) { throw 'The SynthID runtime check failed.' }
Write-Host 'SynthID preprocessing is ready. Refresh the app. Models download on first use.'
