const http   = require('http');
const fs     = require('fs');
const https  = require('https');
const path   = require('path');
const crypto = require('crypto');

// ---- .env ファイルの読み込み（dotenv 不使用） ----
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  });
}

// ---- 設定 ----
const PORT        = process.env.PORT || 8000;
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 10;

const { isGeminiModel, callGenerations, callEdits, callGemini,
  getProviderAvailability, validateGenerationParams } = require('./lib/api');
const { validateMarkupImage } = require('./lib/image-metadata');
const { getImageModelCapabilities } = require('./public/image-models');
const providers = getProviderAvailability();
if (!Object.values(providers).some(Boolean)) {
  console.error('エラー: COMET_API_KEY（旧 OPENAI_API_KEY）、OPENAI_OFFICIAL_API_KEY、NANO_BANANA_API_KEY のいずれかを設定してください。');
  process.exit(1);
}
if (!providers.cometapi) {
  console.warn('警告: CometAPI のキーが未設定です。CometAPI モデルは使用できません。');
}
if (!providers.openai) {
  console.warn('警告: OPENAI_OFFICIAL_API_KEY が未設定です。OpenAI公式モデルは使用できません。');
}
if (!providers.gemini) {
  console.warn('警告: NANO_BANANA_API_KEY が未設定です。Nano Banana モデルは使用できません。');
}

// ---- モジュール読み込み（.env ロード後） ----
const { db, dbSaveEntry, dbDeleteEntry, dbLoadHistory, _stmtFindIdx, _stmtFavoriteImages } = require('./lib/db');
const { createStartGeneration } = require('./lib/generation');
const { createSynthidPreprocessor } = require('./lib/synthid');
const { createImageStore } = require('./lib/image-store');
const { createPushNotifications } = require('./lib/web-push');
const imageStore = createImageStore({ root: __dirname, db });
const synthid = createSynthidPreprocessor({ imageStore });
const pushNotifications = createPushNotifications({ db });

// ---- パス定数 ----
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');
const INPUTS_DIR = path.join(IMAGES_DIR, 'inputs');
const CA_CERT_FILE = path.resolve(__dirname, process.env.HTTPS_CA_CERT_FILE || 'certs/rootCA.pem');
const CERTIFICATE_PATH = '/cert/rootCA.cer';

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
};

// ---- 起動時の初期化 ----
for (const dir of [IMAGES_DIR, INPUTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let history = dbLoadHistory();
imageStore.setHistory(history, synthid.recipeKey);

// ---- 状態管理 ----
const clients          = new Set();
const pendingEntries   = new Map();
const abortControllers = new Map();

// ---- ユーティリティ ----
function generateId() {
  return crypto.randomBytes(12).toString('base64url');
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    client.res.write(`event: update\ndata: ${data}\n\n`);
  }
}

const startGeneration = createStartGeneration({
  MAX_RETRIES, IMAGES_DIR, isGeminiModel,
  callGenerations, callEdits, callGemini,
  preprocessImages: synthid.processImages,
  dbSaveEntry, broadcast, pendingEntries, abortControllers, history,
  notifyGeneration: pushNotifications.notifyGeneration,
});

function sendInitialState(res) {
  const data = JSON.stringify({
    type: 'init',
    history,
    pending: Array.from(pendingEntries.values()),
    providers: getProviderAvailability(),
  });
  res.write(`event: init\ndata: ${data}\n\n`);
}

function readBody(req, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error('リクエストが大きすぎます。')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseJSON(text) {
  try { return JSON.parse(text || '{}'); } catch { return null; }
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// ---- ルートハンドラ ----
async function handleCertificateDownload(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return jsonResponse(res, 405, { error: 'GET または HEAD を使用してください。' });
  }
  let certificate;
  try {
    // Extract DER from X.509 rather than serving file bytes: a PEM bundle can contain private keys.
    const publicCertificate = new crypto.X509Certificate(await fs.promises.readFile(CA_CERT_FILE));
    if (!publicCertificate.ca) throw new Error('A CA certificate is required');
    certificate = publicCertificate.raw;
  } catch (error) {
    return jsonResponse(res, error.code === 'ENOENT' ? 404 : 503, { error: 'ダウンロード用の公開CA証明書が見つからないか、読み込めません。' });
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="rootCA.cer"',
    'Content-Length': certificate.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : certificate);
}

async function handlePush(req, res, pathname) {
  // These endpoints store capability URLs; never expose them via the app's legacy wildcard CORS.
  res.removeHeader('Access-Control-Allow-Origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && pathname === '/push/config') {
    return jsonResponse(res, 200, { publicKey: pushNotifications.publicKey() });
  }
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'POST を使用してください。' });
  let origin;
  try {
    origin = new URL(req.headers.origin);
    if (origin.origin !== req.headers.origin || origin.host !== req.headers.host
      || !['http:', 'https:'].includes(origin.protocol) || req.headers['sec-fetch-site'] === 'cross-site') throw new Error();
  } catch { return jsonResponse(res, 403, { error: 'アプリと同じURLから通知を設定してください。' }); }
  if (!['/push/subscribe', '/push/unsubscribe', '/push/test'].includes(pathname)) {
    return jsonResponse(res, 404, { error: '通知の操作が見つかりません。' });
  }
  let data;
  try { data = parseJSON(await readBody(req, 16384)); }
  catch { return jsonResponse(res, 413, { error: '通知の設定が大きすぎます。' }); }
  if (!data || typeof data !== 'object') return jsonResponse(res, 400, { error: 'JSON が不正です。' });
  try {
    if (pathname === '/push/subscribe') pushNotifications.subscribe(data.subscription, origin.origin);
    else if (pathname === '/push/unsubscribe') pushNotifications.unsubscribe(data.endpoint, origin.origin);
    else {
      if (typeof data.endpoint !== 'string' || data.endpoint.length > 4096) throw new Error('通知先が不正です。');
      await pushNotifications.test(data.endpoint, origin.origin);
    }
    return jsonResponse(res, 200, { status: 'ok' });
  } catch (err) {
    return jsonResponse(res, pathname === '/push/test' ? 502 : 400, { error: err.message });
  }
}

async function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sendInitialState(res);
  const sendClock = () => {
    const data = JSON.stringify({ iso: new Date().toISOString() });
    res.write(`event: clock\ndata: ${data}\n\n`);
  };
  sendClock();
  const client    = { res };
  const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 10000);
  const clockTick = setInterval(sendClock, 1000);
  clients.add(client);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(clockTick);
    clients.delete(client);
  });
}

async function handleHistory(_req, res) {
  jsonResponse(res, 200, { history });
}

async function handleDelete(req, res) {
  const data = parseJSON(await readBody(req));
  if (!data) return jsonResponse(res, 400, { error: 'JSON が不正です' });
  const { id } = data;
  if (!id || typeof id !== 'string') return jsonResponse(res, 400, { error: 'id が必要です' });
  const idx = history.findIndex(e => e.id === id);
  if (idx === -1 && !_stmtFindIdx.get(id)) return jsonResponse(res, 404, { error: 'エントリが見つかりません' });
  if (idx !== -1) history.splice(idx, 1);
  dbDeleteEntry(id);
  broadcast({ type: 'deleted', id });
  jsonResponse(res, 200, { status: 'deleted' });
}

async function handleFavorite(req, res) {
  const data = parseJSON(await readBody(req));
  if (!data) return jsonResponse(res, 400, { error: 'JSON が不正です' });
  const { id, imgUrl, favorited } = data;
  if (!id || typeof id !== 'string') return jsonResponse(res, 400, { error: 'id が必要です' });
  if (!imgUrl || typeof imgUrl !== 'string') return jsonResponse(res, 400, { error: 'imgUrl が必要です' });
  if (!_stmtFindIdx.get(id)) return jsonResponse(res, 404, { error: 'エントリが見つかりません' });
  const entry = history.find(e => e.id === id);
  if (entry) {
    entry.favoritedImages = entry.favoritedImages || [];
    if (favorited) {
      if (!entry.favoritedImages.includes(imgUrl)) entry.favoritedImages.push(imgUrl);
    } else {
      entry.favoritedImages = entry.favoritedImages.filter(u => u !== imgUrl);
    }
  }
  const newList = entry?.favoritedImages ?? (favorited ? [imgUrl] : []);
  _stmtFavoriteImages.run(newList.length ? JSON.stringify(newList) : null, id);
  broadcast({ type: 'favorited', id, imgUrl, favorited: !!favorited });
  jsonResponse(res, 200, { status: 'ok', favorited: !!favorited });
}

async function handleCancel(req, res) {
  const data = parseJSON(await readBody(req));
  if (!data) return jsonResponse(res, 400, { error: 'JSON が不正です' });
  const { id } = data;
  if (!id || typeof id !== 'string') return jsonResponse(res, 400, { error: 'id が必要です' });
  if (!pendingEntries.has(id)) return jsonResponse(res, 404, { error: 'エントリが見つからないか、既に完了しています' });
  abortControllers.get(id)?.abort();
  abortControllers.delete(id);
  pendingEntries.delete(id);
  broadcast({ type: 'cancelled', id });
  jsonResponse(res, 200, { status: 'cancelled' });
}

async function handleGenerate(req, res) {
  const data = parseJSON(await readBody(req));
  if (!data) return jsonResponse(res, 400, { error: 'JSON が不正です' });
  const { prompt, params, inputImages, markupImage } = data;
  if (!prompt || typeof prompt !== 'string') return jsonResponse(res, 400, { error: 'prompt が必要です' });
  let generationParams;
  let markupFile;
  try {
    generationParams = validateGenerationParams(params, { editing: !!inputImages?.length, hasMarkup: !!markupImage });
    if (getImageModelCapabilities(generationParams.model).image26 && inputImages !== undefined) {
      if (!Array.isArray(inputImages) || inputImages.length > 16) throw new Error('入力画像は16枚以下の配列で指定してください。');
      for (const image of inputImages) {
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image?.dataUrl || '')) {
          throw new Error('入力画像にはPNG / JPEG / WebPを指定してください。GIF / SVGはPNGに変換してください。');
        }
        if (Buffer.from(image.dataUrl.split(',')[1], 'base64').length > 50 * 1024 * 1024) throw new Error('入力画像は1枚50MB以下にしてください。');
      }
    }
    if (markupImage) {
      const firstData = inputImages?.[0]?.dataUrl;
      if (typeof firstData !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(firstData)) {
        throw new Error('描き込みの対象にはPNG / JPEG / WebPの入力画像が必要です。');
      }
      markupFile = validateMarkupImage(markupImage, { buffer: Buffer.from(firstData.split(',')[1], 'base64') });
    }
    if (isGeminiModel(generationParams.model) && markupImage) throw new Error('このモデルでは描き込みを利用できません。');
    if (generationParams.remove_synthid !== undefined && typeof generationParams.remove_synthid !== 'boolean') {
      throw new Error('remove_synthid は true / false で指定してください。');
    }
    if (generationParams.remove_synthid) {
      if (!Array.isArray(inputImages) || !inputImages.length) throw new Error('SynthID除去には入力画像が必要です。');
      if (inputImages.some(img => !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(img?.dataUrl || ''))) {
        throw new Error('SynthID除去の入力には PNG / JPEG / WebP を指定してください。');
      }
      const images = inputImages.map(img => ({ buffer: Buffer.from(img.dataUrl.split(',')[1], 'base64') }));
      if (!synthid.areAllCached(images)) {
        const status = await synthid.getStatus();
        if (!status.available) throw new Error(status.message);
      }
    }
  } catch (err) {
    return jsonResponse(res, 400, { error: err.message });
  }

  if (markupFile) markupFile = imageStore.put(markupFile.buffer, markupFile.mimeType);

  const savedInputImagePaths = [];
  const inputImageFiles = [];
  if (Array.isArray(inputImages) && inputImages.length > 0) {
    for (let i = 0; i < inputImages.length; i++) {
      const img = inputImages[i];
      if (!img?.dataUrl) continue;
      const match = img.dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!match) continue;
      const mimeType = match[1];
      const buffer   = Buffer.from(match[2], 'base64');
      const asset = imageStore.put(buffer, mimeType);
      savedInputImagePaths.push(asset.url);
      inputImageFiles.push(asset);
    }
  }

  jsonResponse(res, 202, { status: 'queued' });

  const id    = generateId();
  const entry = {
    id,
    prompt,
    params:      generationParams,
    images:      [],
    inputImages: savedInputImagePaths.length ? savedInputImagePaths : undefined,
    markupImage: markupFile?.url,
    timestamp:   new Date().toISOString(),
    retries:     0,
    status:      'queued',
  };
  pendingEntries.set(id, entry);
  broadcast({ type: 'queued', entry });
  startGeneration(id, entry, prompt, generationParams, inputImageFiles, markupFile);
}

async function handleStaticFile(pathname, res) {
  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.substring(1));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' };
    if (pathname === '/sw.js' || pathname === '/manifest.webmanifest') headers['Cache-Control'] = 'no-cache';
    if (contentType === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---- HTTP / HTTPS サーバー ----
const handleRequest = async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (pathname.startsWith('/push/')) { res.removeHeader('Access-Control-Allow-Origin'); res.writeHead(403); res.end(); return; }
    res.writeHead(204); res.end(); return;
  }

  try {
    if (pathname === CERTIFICATE_PATH) return await handleCertificateDownload(req, res);
    if (pathname.startsWith('/push/')) return await handlePush(req, res, pathname);
    if (pathname === '/events')                              return await handleEvents(req, res);
    if (pathname === '/history')                             return await handleHistory(req, res);
    if (pathname === '/synthid/status' && req.method === 'GET') return jsonResponse(res, 200, await synthid.getStatus());
    if (pathname === '/delete'   && req.method === 'POST')  return await handleDelete(req, res);
    if (pathname === '/cancel'   && req.method === 'POST')  return await handleCancel(req, res);
    if (pathname === '/favorite' && req.method === 'POST')  return await handleFavorite(req, res);
    if (pathname === '/generate' && req.method === 'POST')  return await handleGenerate(req, res);
    await handleStaticFile(pathname, res);
  } catch (err) {
    console.error('リクエスト処理エラー:', err);
    if (!res.headersSent) jsonResponse(res, 500, { error: '内部サーバーエラー' });
  }
};

const certFile = process.env.HTTPS_CERT_FILE;
const keyFile = process.env.HTTPS_KEY_FILE;
if (!!certFile !== !!keyFile) throw new Error('HTTPS_CERT_FILE と HTTPS_KEY_FILE は両方設定してください。');
const defaultCertificatePort = Number(PORT) > 0 && Number(PORT) < 65535 ? Number(PORT) + 1 : 8001;
const certificatePortSetting = process.env.CERT_HTTP_PORT || String(defaultCertificatePort);
const certificatePort = certificatePortSetting === 'off' ? null : Number(certificatePortSetting);
if (certFile && certificatePort !== null && (!Number.isInteger(certificatePort) || certificatePort < 0 || certificatePort > 65535)) {
  throw new Error('CERT_HTTP_PORT には0〜65535のポート番号、または off を設定してください。');
}
if (certFile && certificatePort !== null && certificatePort !== 0 && certificatePort === Number(PORT)) {
  throw new Error('PORT と CERT_HTTP_PORT には異なるポート番号を設定してください。');
}
const server = certFile ? https.createServer({
  cert: fs.readFileSync(path.resolve(__dirname, certFile)), key: fs.readFileSync(path.resolve(__dirname, keyFile)),
}, handleRequest) : http.createServer(handleRequest);

// Keep certificate enrollment reachable over plain HTTP before a device trusts the local CA.
const certificateServer = certFile && certificatePort !== null ? http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === CERTIFICATE_PATH) return await handleCertificateDownload(req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
  } catch {
    if (!res.headersSent) jsonResponse(res, 500, { error: '証明書をダウンロードできませんでした。' });
  }
}) : null;

function listen(serverInstance, port) {
  return new Promise((resolve, reject) => {
    serverInstance.once('error', reject);
    serverInstance.listen(port, resolve);
  });
}

Promise.all([listen(server, PORT), ...(certificateServer ? [listen(certificateServer, certificatePort)] : [])]).then(() => {
  console.log(`サーバー起動: ${certFile ? 'https' : 'http'}://localhost:${server.address().port}`);
  const downloadPort = certificateServer ? certificateServer.address().port : server.address().port;
  if (certificateServer || !certFile) console.log(`証明書HTTP: http://localhost:${downloadPort}${CERTIFICATE_PATH}`);
}).catch(error => {
  console.error('サーバーを起動できませんでした:', error.message);
  process.exit(1);
});
