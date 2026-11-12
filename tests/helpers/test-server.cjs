'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// 実際のHTTP/SSE/SQLiteを使い、外部APIだけを置き換えた隔離サーバー。
async function createTestServer({ cometapi = true, openai = true, gemini = true, synthid = 'missing',
  maxRetries = 1, apiFailures = 0, apiFailureStatus = 400, pushStatus = 201, tls } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-playground-test-'));
  const project = path.resolve(__dirname, '../..');
  fs.copyFileSync(path.join(project, 'server.js'), path.join(root, 'server.js'));
  fs.cpSync(path.join(project, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public'));
  if (synthid !== 'missing') {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts/synthid-worker.py'), `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--check') {
  console.log(JSON.stringify({ available: true, version: '0.41.1', device: 'Test GPU' }));
} else {
  const mode = ${JSON.stringify(synthid)};
  fs.appendFileSync('preprocessing.jsonl', JSON.stringify({ input: process.argv[2], output: process.argv[3] }) + '\\n');
  if (mode === 'fail') { console.error('Test removal failed'); process.exit(1); }
  if (mode === 'stdout-fail') { console.error('Nonfatal dependency warning'); console.log('Error: model loading failed'); process.exit(1); }
  if (mode === 'structured-fail') { console.error('Nonfatal dependency warning'); console.log(JSON.stringify({ error: 'Required tokenizer dependency is missing' })); process.exit(1); }
  if (mode === 'invalid') { fs.writeFileSync(process.argv[3], 'not a PNG'); process.exit(0); }
  const lock = path.resolve('gpu.lock');
  fs.writeFileSync(lock, 'busy', { flag: 'wx' });
  const finish = () => {
    const input = fs.readFileSync(process.argv[2]);
    fs.writeFileSync(process.argv[3], Buffer.concat([input, Buffer.from('local-preprocessing')]));
    fs.unlinkSync(lock);
  };
  setTimeout(finish, mode === 'slow' ? 10000 : 100);
}
`);
  }
  for (const name of fs.readdirSync(path.join(project, 'public'))) {
    if (/\.(js|html|css|webmanifest)$/.test(name)) fs.copyFileSync(path.join(project, 'public', name), path.join(root, 'public', name));
  }
  fs.cpSync(path.join(project, 'public/icons'), path.join(root, 'public/icons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mock-api.cjs'), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
let apiCalls = 0;
globalThis.fetch = async (url, options) => {
  const host = new URL(url).hostname;
  if (host === 'fcm.googleapis.com') {
    fs.appendFileSync('pushes.jsonl', JSON.stringify({ url, headers: options.headers,
      body: Buffer.from(options.body).toString('base64') }) + '\\n');
    return new Response('', { status: ${JSON.stringify(pushStatus)} });
  }
  const expected = { 'api.openai.com': 'Bearer test-official', 'api.cometapi.com': 'Bearer test-comet' };
  const gemini = host === 'generativelanguage.googleapis.com';
  if (gemini) assert.equal(options.headers['x-goog-api-key'], 'test-gemini');
  else {
    assert.ok(expected[host], 'Unexpected external host');
    assert.equal(options.headers.Authorization, expected[host]);
  }
  const model = typeof options.body === 'string' ? JSON.parse(options.body).model : options.body.get('model');
  const fields = typeof options.body === 'string' ? JSON.parse(options.body)
    : Object.fromEntries([...options.body.entries()].filter(([, value]) => typeof value === 'string'));
  const inputImages = gemini ? JSON.parse(options.body).contents[0].parts.filter(p => p.inlineData).map(p => p.inlineData.data)
    : typeof options.body === 'string' ? []
    : await Promise.all(options.body.getAll('image[]').map(async image => Buffer.from(await image.arrayBuffer()).toString('base64')));
  const markup = typeof options.body === 'string' ? null : options.body.get('markup');
  fs.appendFileSync('requests.jsonl', JSON.stringify({ url, model, inputImages, fields,
    markup: markup ? Buffer.from(await markup.arrayBuffer()).toString('base64') : null }) + '\\n');
  if (apiCalls++ < ${JSON.stringify(apiFailures)}) return { ok: false, status: ${JSON.stringify(apiFailureStatus)}, statusText: 'Mock provider error',
    text: async () => JSON.stringify({ error: { message: 'Mock upstream failure' } }) };
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const format = fields.output_format || fields.format || 'png';
  const result = format === 'svg' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#18294b"/><circle cx="256" cy="220" r="120" fill="#58a6ff"/><text x="256" y="430" text-anchor="middle" fill="white" font-size="48">SVG preview</text></svg>').toString('base64')
    : format === 'gif' ? 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' : b64;
  return { ok: true, json: async () => gemini
    ? { candidates: [{ content: { parts: [{ inlineData: { data: b64, mimeType: 'image/png' } }] } }] }
    : { output_format: format, data: [{ b64_json: result }],
      usage: { input_tokens: 13, input_tokens_details: { text_tokens: 13, image_tokens: 0 }, output_tokens: 823, total_tokens: 836 },
      ...(format === 'svg' ? { svg_usage: { model: 'test-svg-author', input_tokens: 10, output_tokens: 20, reasoning_tokens: 0, total_tokens: 30 } } : {}) } };
};
`);
  const child = spawn(process.execPath, ['--require', './mock-api.cjs', 'server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', PORT: '0', MAX_RETRIES: String(maxRetries),
      HTTPS_CERT_FILE: tls?.certFile || '', HTTPS_KEY_FILE: tls?.keyFile || '', WEB_PUSH_SUBJECT: 'mailto:test@example.com',
      HTTPS_CA_CERT_FILE: tls?.caFile || path.join(root, 'missing-ca.pem'), CERT_HTTP_PORT: tls?.certificatePort ?? '0',
      OPENAI_API_KEY: cometapi ? 'test-comet' : '', COMET_API_KEY: '',
      SYNTHID_PYTHON: synthid === 'missing' ? path.join(root, 'missing-python') : process.execPath,
      OPENAI_OFFICIAL_API_KEY: openai ? 'test-official' : '', NANO_BANANA_API_KEY: gemini ? 'test-gemini' : '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { output += chunk; });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    // 削除対象はこのヘルパーが作成した一時ディレクトリに限定する。
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('image-playground-test-')) {
      throw new Error('Unexpected cleanup path');
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server startup timed out: ' + output)), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Test server exited: ' + output)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/サーバー起動: (https?):\/\/localhost:(\d+)/);
        const waitingForCertificate = tls?.certFile && tls.certificatePort !== 'off' && !output.includes('証明書HTTP:');
        if (match && !waitingForCertificate) { clearTimeout(timeout); resolve(match[1] + '://localhost:' + match[2]); }
      });
    });
    const certificateUrl = output.match(/証明書HTTP: (http:\/\/localhost:\d+\/cert\/rootCA\.cer)/)?.[1];
    return { url, certificateUrl, root, close, pushes: () => {
      const log = path.join(root, 'pushes.jsonl');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    }, requests: () => {
      const log = path.join(root, 'requests.jsonl');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    } };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { createTestServer };
