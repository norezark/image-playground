const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

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
const PORT              = process.env.PORT || 8000;
const MAX_RETRIES       = Number(process.env.MAX_RETRIES) || 10;
const API_KEY           = process.env.OPENAI_API_KEY;
const NANO_BANANA_API_KEY = process.env.NANO_BANANA_API_KEY;
const API_BASE          = 'https://api.cometapi.com/v1/images';
const GEMINI_API_BASE   = 'https://generativelanguage.googleapis.com/v1beta';

if (!API_KEY && !NANO_BANANA_API_KEY) {
  console.error('エラー: OPENAI_API_KEY または NANO_BANANA_API_KEY が設定されていません。.env ファイルを確認してください。');
  process.exit(1);
}
if (!API_KEY) {
  console.warn('警告: OPENAI_API_KEY が未設定です。CometAPI モデルは使用できません。');
}
if (!NANO_BANANA_API_KEY) {
  console.warn('警告: NANO_BANANA_API_KEY が未設定です。Nano Banana モデルは使用できません。');
}

function isGeminiModel(model) {
  return typeof model === 'string' && model.startsWith('gemini-');
}

const HISTORY_DB   = path.join(__dirname, 'history.db');
const HISTORY_FILE = path.join(__dirname, 'history.json'); // マイグレーション用
const PUBLIC_DIR   = path.join(__dirname, 'public');
const IMAGES_DIR   = path.join(PUBLIC_DIR, 'images');
const INPUTS_DIR   = path.join(IMAGES_DIR, 'inputs');

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

// ---- SQLite 初期化 ----
const db = new DatabaseSync(HISTORY_DB);
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    prompt      TEXT NOT NULL,
    params      TEXT NOT NULL,
    images      TEXT NOT NULL,
    input_images TEXT,
    timestamp   TEXT NOT NULL,
    retries     INTEGER DEFAULT 0,
    status      TEXT NOT NULL,
    error       TEXT,
    favorited   INTEGER DEFAULT 0
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp ON entries (timestamp DESC)`);
// favorited カラムが存在しない場合は追加（旧 DB の後方互換）
try { db.exec('ALTER TABLE entries ADD COLUMN favorited INTEGER DEFAULT 0'); } catch {}
// favorited_images カラムが存在しない場合は追加
try { db.exec('ALTER TABLE entries ADD COLUMN favorited_images TEXT DEFAULT NULL'); } catch {}

const _stmtInsert = db.prepare(
  `INSERT OR REPLACE INTO entries (id, prompt, params, images, input_images, timestamp, retries, status, error, favorited_images)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const _stmtFavoriteImages = db.prepare(`UPDATE entries SET favorited_images = ? WHERE id = ?`);
const _stmtDelete  = db.prepare(`DELETE FROM entries WHERE id = ?`);
const _stmtAll     = db.prepare(`SELECT * FROM entries ORDER BY timestamp DESC`);
const _stmtFindIdx = db.prepare(`SELECT id FROM entries WHERE id = ?`);

function _rowToEntry(row) {
  return {
    id:             row.id,
    prompt:         row.prompt,
    params:         JSON.parse(row.params),
    images:         JSON.parse(row.images),
    inputImages:    row.input_images ? JSON.parse(row.input_images) : undefined,
    timestamp:      row.timestamp,
    retries:        row.retries,
    status:         row.status,
    error:          row.error || undefined,
    favoritedImages: row.favorited_images ? JSON.parse(row.favorited_images) : [],
  };
}

function dbSaveEntry(entry) {
  _stmtInsert.run(
    entry.id,
    entry.prompt,
    JSON.stringify(entry.params || {}),
    JSON.stringify(entry.images || []),
    entry.inputImages ? JSON.stringify(entry.inputImages) : null,
    entry.timestamp,
    entry.retries || 0,
    entry.status,
    entry.error || null,
    entry.favoritedImages?.length ? JSON.stringify(entry.favoritedImages) : null,
  );
}

function dbDeleteEntry(id) {
  _stmtDelete.run(id);
}

function dbLoadHistory() {
  return _stmtAll.all().map(_rowToEntry);
}

// ---- history.json からの移行 ----
if (fs.existsSync(HISTORY_FILE)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (Array.isArray(legacy) && legacy.length > 0) {
      const migrate = db.prepare(
        `INSERT OR IGNORE INTO entries (id, prompt, params, images, input_images, timestamp, retries, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      db.exec('BEGIN');
      for (const e of legacy) {
        try {
          migrate.run(
            e.id, e.prompt,
            JSON.stringify(e.params || {}),
            JSON.stringify(e.images || []),
            e.inputImages ? JSON.stringify(e.inputImages) : null,
            e.timestamp, e.retries || 0,
            e.status || 'completed',
            e.error || null,
          );
        } catch { /* skip invalid entries */ }
      }
      db.exec('COMMIT');
      console.log(`history.json から ${legacy.length} 件を SQLite へ移行しました。`);
      fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.bak');
    }
  } catch (err) {
    console.error('history.json の移行に失敗しました:', err);
  }
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

// saveHistory は廃止。dbSaveEntry / dbDeleteEntry を直接使用する。

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    client.res.write(`event: update\ndata: ${data}\n\n`);
  }
}

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

// ---- OpenAI API 呼び出し ----
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).error?.message || detail; } catch {}
    throw new Error(`API リクエスト失敗: ${res.status} ${res.statusText} - ${detail}`);
  }
  return res.json();
}

async function callGenerations(prompt, params, signal) {
  const payload = {
    model:  params.model || 'gpt-image-2',
    prompt,
    n:      params.n ? Number(params.n) : 1,
    size:   params.size || '1024x1024',
  };
  if (params.quality)        payload.quality        = params.quality;
  if (params.input_fidelity) payload.input_fidelity = params.input_fidelity;
  if (params.background)     payload.background     = params.background;
  if (params.format)         payload.format         = params.format;
  if (params.moderation)     payload.moderation     = params.moderation;
  if (params.style)          payload.style          = params.style;
  if (params.output_compression !== undefined && params.output_compression !== '') {
    const v = parseInt(params.output_compression, 10);
    if (!Number.isNaN(v)) payload.output_compression = v;
  }
  return apiFetch(`${API_BASE}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
    signal,
  });
}

async function callEdits(prompt, params, inputImageFiles, signal) {
  const form = new FormData();
  form.append('model',  params.model || 'gpt-image-1.5');
  form.append('prompt', prompt);
  if (params.n)              form.append('n',             String(Number(params.n)));
  if (params.size)           form.append('size',          params.size);
  if (params.quality)        form.append('quality',       params.quality);
  if (params.input_fidelity) form.append('input_fidelity', params.input_fidelity);
  if (params.background)     form.append('background',    params.background);
  if (params.format)         form.append('output_format', params.format);
  if (params.moderation)     form.append('moderation',    params.moderation);
  if (params.output_compression !== undefined && params.output_compression !== '') {
    const v = parseInt(params.output_compression, 10);
    if (!Number.isNaN(v)) form.append('output_compression', String(v));
  }
  for (const img of inputImageFiles) {
    form.append('image[]', new Blob([img.buffer], { type: img.mimeType }), img.filename);
  }
  return apiFetch(`${API_BASE}/edits`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    body: form,
    signal,
  });
}

// ---- Gemini API 呼び出し ----
async function callGemini(prompt, params, inputImageFiles, signal) {
  if (!NANO_BANANA_API_KEY) {
    throw new Error('NANO_BANANA_API_KEY が設定されていません');
  }
  const model = params.model;
  const n     = Math.max(1, Number(params.n) || 1);

  const parts = [{ text: prompt }];
  for (const img of inputImageFiles) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data:     img.buffer.toString('base64'),
      },
    });
  }

  const modalities = params.gemini_output_format === 'IMAGE_AND_TEXT' ? ['TEXT', 'IMAGE'] : ['IMAGE'];
  const generationConfig = { responseModalities: modalities };
  const aspectRatio  = params.gemini_aspect_ratio;
  const imageSize    = params.gemini_image_size;
  const useImageSize = imageSize && model !== 'gemini-2.5-flash-image';
  if (aspectRatio || useImageSize) {
    generationConfig.imageConfig = {};
    if (aspectRatio)    generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (useImageSize)   generationConfig.imageConfig.imageSize   = imageSize;
  }
  if (params.gemini_temperature !== undefined && params.gemini_temperature !== null) {
    generationConfig.temperature = Number(params.gemini_temperature);
  }
  if (params.gemini_top_p !== undefined && params.gemini_top_p !== null) {
    generationConfig.topP = Number(params.gemini_top_p);
  }
  if (params.gemini_thinking_level) {
    generationConfig.thinkingConfig = { thinkingLevel: params.gemini_thinking_level };
  }

  const supportsImageSearch = model === 'gemini-3.1-flash-image-preview';
  const useWebSearch   = !!params.gemini_grounding_web;
  const useImageSearch = !!params.gemini_grounding_image && supportsImageSearch;
  const tools = [];
  if (useWebSearch || useImageSearch) {
    if (useWebSearch && !useImageSearch) {
      tools.push({ googleSearch: {} });
    } else {
      const searchTypes = {};
      if (useWebSearch)   searchTypes.webSearch   = {};
      if (useImageSearch) searchTypes.imageSearch = {};
      tools.push({ googleSearch: { searchTypes } });
    }
  }

  const body = { contents: [{ parts }], generationConfig };
  if (tools.length > 0) body.tools = tools;
  const url  = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const makeRequest = () => apiFetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': NANO_BANANA_API_KEY },
    body:    JSON.stringify(body),
    signal,
  });

  const results = await Promise.all(Array.from({ length: n }, makeRequest));

  const data = [];
  const textReasons = [];
  for (const res of results) {
    const candidate = res?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    for (const part of (candidate?.content?.parts || [])) {
      if (!part.thought && part.inlineData?.data) {
        data.push({ b64_json: part.inlineData.data, mime_type: part.inlineData.mimeType || 'image/png' });
      } else if (part.text) {
        textReasons.push(part.text.trim());
      }
    }
    if (data.length === 0 && finishReason && finishReason !== 'STOP') {
      textReasons.push(`finishReason: ${finishReason}`);
    }
  }

  if (data.length === 0) {
    const reason = textReasons.filter(Boolean).join(' / ') || '画像が生成されませんでした（モデレーションによりブロックされた可能性があります）';
    throw new Error(reason);
  }

  return { data };
}

// ---- 画像生成（リトライ付き） ----
function startGeneration(id, entry, prompt, params, inputImageFiles) {
  let attempt = 0;

  async function tryGenerate() {
    if (!pendingEntries.has(id)) return;
    try {
      attempt++;
      const ac = new AbortController();
      abortControllers.set(id, ac);

      const response = isGeminiModel(params?.model)
        ? await callGemini(prompt, params, inputImageFiles, ac.signal)
        : inputImageFiles.length
          ? await callEdits(prompt, params, inputImageFiles, ac.signal)
          : await callGenerations(prompt, params, ac.signal);

      abortControllers.delete(id);
      if (!pendingEntries.has(id)) return;

      const fmt = params?.format === 'jpeg' ? 'jpeg' : params?.format === 'webp' ? 'webp' : 'png';
      entry.images = (response?.data || []).map((item, idx) => {
        if (item.url) return item.url;
        const itemFmt = item.mime_type === 'image/jpeg' ? 'jpeg' : item.mime_type === 'image/webp' ? 'webp' : fmt;
        const filename = `${entry.id}-${idx}.${itemFmt}`;
        fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(item.b64_json, 'base64'));
        return `/images/${filename}`;
      });
      entry.status = 'completed';
      entry.error  = undefined;
      history.unshift(entry);
      dbSaveEntry(entry);
      pendingEntries.delete(id);
      broadcast({ type: 'completed', entry });
    } catch (err) {
      abortControllers.delete(id);
      if (err.name === 'AbortError') return;
      console.error('生成エラー:', err.message);
      entry.error = err.message;

      if (attempt < MAX_RETRIES) {
        if (!pendingEntries.has(id)) return;
        entry.retries = attempt;
        entry.status  = 'retrying';
        broadcast({ type: 'retry', id: entry.id, retries: entry.retries, error: entry.error });
        tryGenerate();
      } else {
        entry.retries = attempt;
        entry.status  = 'error';
        history.unshift(entry);
        dbSaveEntry(entry);
        pendingEntries.delete(id);
        broadcast({ type: 'error', id: entry.id, error: err.message, entry });
      }
    }
  }

  tryGenerate();
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
