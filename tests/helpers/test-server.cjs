'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// 実際のHTTP/SSE/SQLiteを使い、外部APIだけを置き換えた隔離サーバー。
async function createTestServer({ cometapi = true, openai = true, gemini = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-playground-test-'));
  const project = path.resolve(__dirname, '../..');
  fs.copyFileSync(path.join(project, 'server.js'), path.join(root, 'server.js'));
  fs.cpSync(path.join(project, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public'));
  for (const name of fs.readdirSync(path.join(project, 'public'))) {
    if (/\.(js|html|css)$/.test(name)) fs.copyFileSync(path.join(project, 'public', name), path.join(root, 'public', name));
  }
  fs.writeFileSync(path.join(root, 'mock-api.cjs'), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
globalThis.fetch = async (url, options) => {
  const host = new URL(url).hostname;
  const expected = { 'api.openai.com': 'Bearer test-official', 'api.cometapi.com': 'Bearer test-comet' };
  const gemini = host === 'generativelanguage.googleapis.com';
  if (gemini) assert.equal(options.headers['x-goog-api-key'], 'test-gemini');
  else {
    assert.ok(expected[host], 'Unexpected external host');
    assert.equal(options.headers.Authorization, expected[host]);
  }
  const model = typeof options.body === 'string' ? JSON.parse(options.body).model : options.body.get('model');
  fs.appendFileSync('requests.jsonl', JSON.stringify({ url, model }) + '\\n');
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  return { ok: true, json: async () => gemini
    ? { candidates: [{ content: { parts: [{ inlineData: { data: b64, mimeType: 'image/png' } }] } }] }
    : { data: [{ b64_json: b64 }] } };
};
`);
  const child = spawn(process.execPath, ['--require', './mock-api.cjs', 'server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', PORT: '0', MAX_RETRIES: '1',
      OPENAI_API_KEY: cometapi ? 'test-comet' : '', COMET_API_KEY: '',
      OPENAI_OFFICIAL_API_KEY: openai ? 'test-official' : '', NANO_BANANA_API_KEY: gemini ? 'test-gemini' : '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
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
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve('http://localhost:' + match[1]); }
      });
    });
    return { url, root, close, requests: () => {
      const log = path.join(root, 'requests.jsonl');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    } };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { createTestServer };
