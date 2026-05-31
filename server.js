const http   = require('http');
const fs     = require('fs');
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

if (!process.env.OPENAI_API_KEY && !process.env.NANO_BANANA_API_KEY) {
  console.error('エラー: OPENAI_API_KEY または NANO_BANANA_API_KEY が設定されていません。.env ファイルを確認してください。');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.warn('警告: OPENAI_API_KEY が未設定です。CometAPI モデルは使用できません。');
}
if (!process.env.NANO_BANANA_API_KEY) {
  console.warn('警告: NANO_BANANA_API_KEY が未設定です。Nano Banana モデルは使用できません。');
}

// ---- モジュール読み込み（.env ロード後） ----
const { dbSaveEntry, dbDeleteEntry, dbLoadHistory, _stmtFindIdx, _stmtFavoriteImages } = require('./lib/db');
const { isGeminiModel, callGenerations, callEdits, callGemini } = require('./lib/api');
const { createStartGeneration } = require('./lib/generation');

// ---- パス定数 ----
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');
const INPUTS_DIR = path.join(IMAGES_DIR, 'inputs');

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

// ---- 起動時の初期化 ----
for (const dir of [IMAGES_DIR, INPUTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let history = dbLoadHistory();

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
  dbSaveEntry, broadcast, pendingEntries, abortControllers, history,
});

function sendInitialState(res) {
  const data = JSON.stringify({
    type: 'init',
    history,
    pending: Array.from(pendingEntries.values()),
  });
  res.write(`event: init\ndata: ${data}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
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
async function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sendInitialState(res);
  const client    = { res };
  const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 10000);
  clients.add(client);
  req.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
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
  const { prompt, params, inputImages } = data;
  if (!prompt || typeof prompt !== 'string') return jsonResponse(res, 400, { error: 'prompt が必要です' });

  const savedInputImagePaths = [];
  const inputImageFiles = [];
  if (Array.isArray(inputImages) && inputImages.length > 0) {
    const reqId = generateId();
    for (let i = 0; i < inputImages.length; i++) {
      const img = inputImages[i];
      if (!img?.dataUrl) continue;
      const match = img.dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!match) continue;
      const mimeType = match[1];
      const ext      = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
      const filename = `input-${reqId}-${i}.${ext}`;
      const buffer   = Buffer.from(match[2], 'base64');
      fs.writeFileSync(path.join(INPUTS_DIR, filename), buffer);
      savedInputImagePaths.push(`/images/inputs/${filename}`);
      inputImageFiles.push({ buffer, mimeType, filename });
    }
  }

  jsonResponse(res, 202, { status: 'queued' });

  const id    = generateId();
  const entry = {
    id,
    prompt,
    params:      params || {},
    images:      [],
    inputImages: savedInputImagePaths.length ? savedInputImagePaths : undefined,
    timestamp:   new Date().toISOString(),
    retries:     0,
    status:      'queued',
  };
  pendingEntries.set(id, entry);
  broadcast({ type: 'queued', entry });
  startGeneration(id, entry, prompt, params || {}, inputImageFiles);
}

async function handleStaticFile(pathname, res) {
  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.substring(1));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ---- HTTP サーバー ----
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (pathname === '/events')                              return await handleEvents(req, res);
    if (pathname === '/history')                             return await handleHistory(req, res);
    if (pathname === '/delete'   && req.method === 'POST')  return await handleDelete(req, res);
    if (pathname === '/cancel'   && req.method === 'POST')  return await handleCancel(req, res);
    if (pathname === '/favorite' && req.method === 'POST')  return await handleFavorite(req, res);
    if (pathname === '/generate' && req.method === 'POST')  return await handleGenerate(req, res);
    await handleStaticFile(pathname, res);
  } catch (err) {
    console.error('リクエスト処理エラー:', err);
    if (!res.headersSent) jsonResponse(res, 500, { error: '内部サーバーエラー' });
  }
});

server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});
