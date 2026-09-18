'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createTestServer } = require('./helpers/test-server.cjs');
const { createStartGeneration } = require('../lib/generation');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const input = () => ({ dataUrl: 'data:image/png;base64,' + png.toString('base64') });
const processed = Buffer.concat([png, Buffer.from('local-preprocessing')]);

async function generate(app, params, images = [input()]) {
  return fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Change the background', params: { model: 'gpt-image-2.5-flare', ...params }, inputImages: images }),
    signal: AbortSignal.timeout(10000) });
}

async function completed(app, count = 1) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const { history } = await (await fetch(app.url + '/history')).json();
    if (history.length >= count) return history;
    await delay(20);
  }
  throw new Error('Generation did not finish');
}

test('off preserves original bytes; missing engine rejects opt-in before storing inputs', async t => {
  const app = await createTestServer();
  t.after(app.close);
  assert.equal((await (await fetch(app.url + '/synthid/status')).json()).available, false);
  assert.equal((await generate(app, { remove_synthid: true })).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'public/images/inputs')), []);
  assert.equal((await generate(app, { remove_synthid: false })).status, 202);
  const [entry] = await completed(app);
  assert.equal(entry.processedInputImages, undefined);
  assert.deepEqual(app.requests()[0].inputImages, [png.toString('base64')]);
  assert.equal(fs.existsSync(path.join(app.root, '.synthid')), false);
});

test('on processes every input, sends only processed bytes to all providers, and preserves output and originals', async t => {
  const app = await createTestServer({ synthid: 'ready' });
  t.after(app.close);
  assert.equal((await (await fetch(app.url + '/synthid/status')).json()).available, true);
  for (const params of [
    { provider: 'cometapi' }, { provider: 'openai' }, { provider: 'gemini', model: 'gemini-3.1-flash-image-preview' },
  ]) assert.equal((await generate(app, { ...params, remove_synthid: true }, [input(), input()])).status, 202);
  const history = await completed(app, 3);
  for (const entry of history) {
    assert.equal(entry.status, 'completed', entry.error);
    assert.equal(entry.params.remove_synthid, true);
    assert.equal(entry.processedInputImages.length, 2);
    for (const u of entry.inputImages) assert.deepEqual(fs.readFileSync(path.join(app.root, 'public', u)), png);
    for (const u of entry.processedInputImages) assert.deepEqual(fs.readFileSync(path.join(app.root, 'public', u)), processed);
    assert.deepEqual(fs.readFileSync(path.join(app.root, 'public', entry.images[0])), png);
  }
  assert.equal(app.requests().length, 3);
  assert.equal(fs.readFileSync(path.join(app.root, 'preprocessing.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(new Set(history.flatMap(entry => entry.inputImages)).size, 1);
  assert.equal(new Set(history.flatMap(entry => entry.processedInputImages)).size, 1);
  assert.equal(fs.readdirSync(path.join(app.root, 'public/images/inputs')).length, 2);
  for (const request of app.requests()) assert.deepEqual(request.inputImages, [processed.toString('base64'), processed.toString('base64')]);
  assert.deepEqual(fs.readdirSync(path.join(app.root, '.synthid/jobs')), []);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(app.root, 'history.db'), { readOnly: true });
  try {
    assert.ok(db.prepare('SELECT processed_input_images FROM entries').all().every(row => JSON.parse(row.processed_input_images).length === 2));
  } finally { db.close(); }
});

test('deleting history retains shared inputs and cache-only edits work without the engine', async t => {
  const app = await createTestServer({ synthid: 'ready' });
  t.after(app.close);
  assert.equal((await generate(app, { remove_synthid: true })).status, 202);
  const [first] = await completed(app);
  const files = fs.readdirSync(path.join(app.root, 'public/images/inputs'));
  const removed = await fetch(app.url + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: first.id }) });
  assert.equal(removed.status, 200);
  assert.deepEqual((await (await fetch(app.url + '/history')).json()).history, []);
  const worker = path.join(app.root, 'scripts/synthid-worker.py');
  fs.renameSync(worker, worker + '.disabled');
  const status = await (await fetch(app.url + '/synthid/status')).json();
  assert.equal(status.available, false);
  assert.equal(status.cachedImages, 1);
  assert.equal((await generate(app, { provider: 'openai', remove_synthid: true })).status, 202);
  const [second] = await completed(app);
  assert.equal(second.status, 'completed', second.error);
  assert.deepEqual(second.inputImages, first.inputImages);
  assert.deepEqual(second.processedInputImages, first.processedInputImages);
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'public/images/inputs')), files);
  assert.equal(fs.readFileSync(path.join(app.root, 'preprocessing.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(app.requests()[1].inputImages, [processed.toString('base64')]);
  const different = { dataUrl: 'data:image/png;base64,' + Buffer.concat([png, Buffer.from('new')]).toString('base64') };
  assert.equal((await generate(app, { remove_synthid: true }, [different])).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'public/images/inputs')), files);
});

for (const mode of ['fail', 'invalid']) test(`remover ${mode} never falls back to original or calls the API`, async t => {
  const app = await createTestServer({ synthid: mode });
  t.after(app.close);
  assert.equal((await generate(app, { remove_synthid: true })).status, 202);
  const [entry] = await completed(app);
  assert.equal(entry.status, 'error');
  assert.equal(entry.retries, 0);
  assert.ok(entry.error);
  assert.deepEqual(app.requests(), []);
  assert.deepEqual(fs.readdirSync(path.join(app.root, '.synthid/jobs')), []);
});

test('rejects invalid options, missing inputs, and unsupported formats before saving anything', async t => {
  const app = await createTestServer({ synthid: 'ready' });
  t.after(app.close);
  assert.equal((await generate(app, { remove_synthid: 'true' })).status, 400);
  assert.equal((await generate(app, { remove_synthid: true }, [])).status, 400);
  assert.equal((await generate(app, { remove_synthid: true }, [{ dataUrl: 'data:image/gif;base64,AAAA' }])).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'public/images/inputs')), []);
  assert.deepEqual(app.requests(), []);
});

for (const [mode, detail] of [
  ['stdout-fail', 'model loading failed'],
  ['structured-fail', 'Required tokenizer dependency is missing'],
]) test(`${mode} reports the model error instead of only progress warnings`, async t => {
  const app = await createTestServer({ synthid: mode });
  t.after(app.close);
  assert.equal((await generate(app, { remove_synthid: true })).status, 202);
  const [entry] = await completed(app);
  assert.equal(entry.status, 'error');
  assert.ok(entry.error.includes(detail), entry.error);
  if (mode === 'structured-fail') assert.equal(entry.error, detail);
  assert.deepEqual(app.requests(), []);
});

test('cancellation stops the worker, cleans temporary files, and sends nothing to the edit API', async t => {
  const app = await createTestServer({ synthid: 'slow' });
  t.after(app.close);
  const events = await fetch(app.url + '/events', { signal: AbortSignal.timeout(10000) });
  const reader = events.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  assert.equal((await generate(app, { remove_synthid: true })).status, 202);
  let id, text = '';
  while (!id) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
    for (const match of text.matchAll(/event: update\ndata: ([^\n]+)/g)) {
      const event = JSON.parse(match[1]);
      if (event.type === 'queued') id = event.entry.id;
    }
  }
  for (let i = 0; i < 100 && !fs.existsSync(path.join(app.root, 'gpu.lock')); i++) await delay(20);
  assert.ok(fs.existsSync(path.join(app.root, 'gpu.lock')));
  const response = await fetch(app.url + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  assert.equal(response.status, 200);
  for (let i = 0; i < 100 && fs.readdirSync(path.join(app.root, '.synthid/jobs')).length; i++) await delay(20);
  assert.deepEqual(fs.readdirSync(path.join(app.root, '.synthid/jobs')), []);
  assert.deepEqual(app.requests(), []);
  assert.deepEqual((await (await fetch(app.url + '/history')).json()).history, []);
});

test('API retries reuse one preprocessing result and never forward the local option', async t => {
  const app = await createTestServer();
  t.after(app.close);
  const params = { model: 'gpt-image-2.5-flare', remove_synthid: true };
  const entry = { id: 'retry-test', params, images: [], status: 'queued' };
  const pending = new Map([[entry.id, entry]]);
  let scrubCalls = 0, apiCalls = 0;
  const run = createStartGeneration({ MAX_RETRIES: 2, IMAGES_DIR: path.join(app.root, 'public/images'),
    isGeminiModel: () => false,
    preprocessImages: async () => { scrubCalls++; return [{ buffer: processed, mimeType: 'image/png', url: '/images/inputs/processed.png' }]; },
    callEdits: async (_prompt, sent, files) => {
      apiCalls++;
      assert.equal(Object.hasOwn(sent, 'remove_synthid'), false);
      assert.deepEqual(files[0].buffer, processed);
      if (apiCalls === 1) throw new Error('Retry this API failure');
      return { data: [{ b64_json: png.toString('base64') }] };
    }, dbSaveEntry: () => {}, broadcast: () => {}, pendingEntries: pending, abortControllers: new Map(), history: [],
  });
  await run(entry.id, entry, 'edit', params, [{ buffer: png }]);
  assert.equal(scrubCalls, 1);
  assert.equal(apiCalls, 2);
  assert.equal(entry.status, 'completed');
  assert.equal(params.remove_synthid, true);
});
