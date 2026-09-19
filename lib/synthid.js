'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const VERSION = '0.41.1';
const abortError = () => Object.assign(new Error('SynthID preprocessing cancelled'), { name: 'AbortError' });

function createSynthidPreprocessor({
  root = path.resolve(__dirname, '..'),
  python = process.env.SYNTHID_PYTHON || path.join(root, '.synthid', 'venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  worker = path.join(root, 'scripts', 'synthid-worker.py'),
  chromaPrecision = process.env.SYNTHID_CHROMA_PRECISION || 'nf4',
  qwenPrecision = process.env.SYNTHID_QWEN_PRECISION || 'nf4',
  timeoutMs = Number(process.env.SYNTHID_TIMEOUT_MS) || 30 * 60 * 1000,
  imageStore,
} = {}) {
  if (!imageStore) throw new Error('An image store is required for SynthID preprocessing');
  if (!['nf4', 'bf16'].includes(chromaPrecision)) throw new Error('SYNTHID_CHROMA_PRECISION must be nf4 or bf16');
  if (!['nf4', 'fp8'].includes(qwenPrecision)) throw new Error('SYNTHID_QWEN_PRECISION must be nf4 or fp8');
  const qwenWorker = path.join(root, 'scripts', 'synthid_qwen.py');
  const recipeKey = createHash('sha256').update(`remove-ai-watermarks:${VERSION}:v1\0`)
    .update(`chroma:${chromaPrecision}\0`)
    .update(`qwen:${qwenPrecision}\0`)
    .update(fs.existsSync(qwenWorker) ? fs.readFileSync(qwenWorker) : 'qwen-worker-unavailable')
    .update(fs.existsSync(worker) ? fs.readFileSync(worker) : 'worker-unavailable').digest('hex');
  const runtimeDir = path.join(root, '.synthid');
  const jobsDir = path.join(runtimeDir, 'jobs');
  let statusCache;
  let statusPromise;
  let tail = Promise.resolve();

  function run(args, { signal, timeout = timeoutMs, logFile } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      // The local model needs no generation API credentials. Do not let the
      // third-party CLI load this app's .env either.
      const env = { ...process.env, SYNTHID_CHROMA_PRECISION: chromaPrecision,
        SYNTHID_QWEN_PRECISION: qwenPrecision,
        PYTHON_DOTENV_DISABLED: '1', PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1', HF_HOME: path.join(runtimeDir, 'models'),
        DIFFSYNTH_MODEL_BASE_PATH: path.join(runtimeDir, 'models', 'diffsynth'),
        XDG_CACHE_HOME: path.join(runtimeDir, 'cache'), MODELSCOPE_CACHE: path.join(runtimeDir, 'modelscope'),
        TORCH_HOME: path.join(runtimeDir, 'torch'), HF_HUB_DISABLE_TELEMETRY: '1' };
      for (const name of Object.keys(env)) {
        if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) delete env[name];
      }
      const child = spawn(python, [worker, ...args], {
        cwd: root, windowsHide: true, shell: false, env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', diagnostics = '', stopped;
      const started = Date.now();
      const record = (channel, chunk) => {
        diagnostics = (diagnostics + `\n[${((Date.now() - started) / 1000).toFixed(1)}s ${channel}] ${chunk}`).slice(-64000);
      };
      const withLog = error => {
        if (logFile && error.name !== 'AbortError') {
          try {
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.writeFileSync(logFile, diagnostics || 'Worker produced no output.\n');
            error.message += `\nログ: ${path.relative(root, logFile)}`;
          } catch {} // Preserve the original failure if the disk is unavailable.
        }
        return error;
      };
      const stop = (error) => { stopped ||= error; child.kill(); };
      const onAbort = () => stop(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop(new Error('SynthID除去がタイムアウトしました。')), timeout);
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-12000); record('stdout', chunk); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); record('stderr', chunk); });
      child.on('error', error => { stopped ||= error; });
      child.once('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (stopped) return reject(withLog(stopped));
        if (code !== 0) {
          let detail;
          try { detail = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)).error; } catch {}
          // CLI failures may be on stdout even when stderr contains warnings.
          if (!detail) detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
          return reject(withLog(new Error((detail || `Worker exited with code ${code}`).slice(-2000))));
        }
        resolve(stdout);
      });
      if (signal?.aborted) onAbort();
    });
  }

  async function getRuntimeStatus() {
    if (!fs.existsSync(python) || !fs.existsSync(worker)) {
      return { available: false, message: 'SynthID除去エンジン未設定。scripts/setup-synthid.ps1 を実行してください。' };
    }
    if (statusCache && Date.now() - statusCache.at < 30000) return statusCache.value;
    if (!statusPromise) {
      statusPromise = (async () => {
        let value;
        try {
          const output = await run(['--check'], { timeout: 60000 });
          value = JSON.parse(output.trim().split(/\r?\n/).at(-1));
          if (value.available !== true || value.version !== VERSION) throw new Error('除去エンジンの応答が不正です。');
        } catch (error) {
          value = { available: false, message: `SynthID除去エンジンを使用できません: ${error.message}` };
        }
        statusCache = { at: Date.now(), value };
        return value;
      })().finally(() => { statusPromise = null; });
    }
    return statusPromise;
  }

  async function getStatus() {
    return { ...await getRuntimeStatus(), cachedImages: imageStore.cacheCount(recipeKey) };
  }

  function areAllCached(images) {
    return images.length > 0 && images.every(image => imageStore.getPreprocessed(image.buffer, recipeKey));
  }

  function waitForTask(task, signal) {
    if (!signal) return task;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async function processOne(image, { signal, onProgress }) {
    let jobDir;
    try {
      if (signal?.aborted) throw abortError();
      // Recheck after the preceding GPU job; concurrent requests for the same
      // input then reuse its result without running another worker.
      const cached = imageStore.getPreprocessed(image.buffer, recipeKey);
      if (cached) {
        onProgress('保存済みの除去結果を再利用');
        return { ...cached, cacheHit: true };
      }
      onProgress('SynthID除去処理中…');
      fs.mkdirSync(jobsDir, { recursive: true });
      jobDir = fs.mkdtempSync(path.join(jobsDir, 'job-'));
      const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png';
      const input = path.join(jobDir, `input.${extension}`);
      const output = path.join(jobDir, 'output.png');
      fs.writeFileSync(input, image.buffer);
      await run([input, output], { signal,
        logFile: path.join(runtimeDir, 'logs', `${path.basename(jobDir)}.log`) });
      if (signal?.aborted) throw abortError();
      // Save each successful result before the edit API or another input runs.
      return { ...imageStore.savePreprocessed(image.buffer, recipeKey, fs.readFileSync(output)), cacheHit: false };
    } finally {
      if (jobDir && path.dirname(path.resolve(jobDir)) === path.resolve(jobsDir)
        && path.basename(jobDir).startsWith('job-')) {
        fs.rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }

  async function processImages(images, { signal, onProgress = () => {} } = {}) {
    if (!images.length) throw new Error('SynthID除去には入力画像が必要です。');
    const processed = [];
    for (let index = 0; index < images.length; index++) {
      if (signal?.aborted) throw abortError();
      const progress = message => onProgress(`${message} (${index + 1}/${images.length})`);
      const cached = imageStore.getPreprocessed(images[index].buffer, recipeKey);
      if (cached) {
        progress('保存済みの除去結果を再利用');
        processed.push({ ...cached, cacheHit: true });
        continue;
      }
      progress('SynthID除去の順番待ち…');
      const task = tail.then(() => processOne(images[index], { signal, onProgress: progress }));
      // Cancellation of a waiting caller must not release the GPU queue early.
      tail = task.then(() => {}, () => {});
      processed.push(await waitForTask(task, signal));
    }
    return processed;
  }

  return { getStatus, processImages, areAllCached, recipeKey };
}

module.exports = { createSynthidPreprocessor, VERSION };
