'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { callGenerations, callEdits } = require('../lib/api');
const { validateImageOptions } = require('../public/image-models');
const { validateMarkupImage, imageDimensions } = require('../lib/image-metadata');
const { createStartGeneration } = require('../lib/generation');
const { createTestServer } = require('./helpers/test-server.cjs');
const { png } = require('./helpers/image-fixtures.cjs');
const models = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'];

beforeEach(t => {
  for (const [name, value] of Object.entries({ COMET_API_KEY: 'test-comet', OPENAI_OFFICIAL_API_KEY: 'test-official' })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
});

test('2.6 models send identical new options through both providers with separate credentials', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ data: [] }) };
  });
  for (const model of models) for (const provider of ['cometapi', 'openai']) {
    for (const format of ['png', 'webp', 'gif', 'svg']) {
      await callGenerations('A looping lantern', { model, provider, quality: 'xhigh', complexity: 'medium',
        format, input_fidelity: 'high', ...(format === 'gif' ? { frame_count: '12', frame_duration_ms: '120' } : {}),
        ...(format === 'svg' ? { svg_model: 'chosen-author', svg_reasoning: 'high' } : {}) });
      const request = requests.at(-1);
      const body = JSON.parse(request.body);
      assert.equal(new URL(request.url).hostname, provider === 'cometapi' ? 'api.cometapi.com' : 'api.openai.com');
      assert.equal(request.headers.Authorization, provider === 'cometapi' ? 'Bearer test-comet' : 'Bearer test-official');
      assert.equal(body.output_format, format);
      assert.equal(body.complexity, 'medium');
      assert.equal(body.quality, 'xhigh');
      assert.equal('format' in body, false);
      assert.equal('input_fidelity' in body, false);
      if (format === 'gif') assert.deepEqual([body.frame_count, body.frame_duration_ms], [12, 120]);
      if (format === 'svg') assert.deepEqual(body.svg, { model: 'chosen-author', reasoning: { effort: 'high' } });
    }
    const files = ['first', 'reference'].map(name => ({ buffer: png(16, 16), mimeType: 'image/png', filename: name + '.png' }));
    const markup = { buffer: png(16, 16), mimeType: 'image/png', filename: 'markup.png' };
    await callEdits('Change the circled object', { model, provider, format: 'gif', complexity: 'low', input_fidelity: 'low', frame_count: 4 }, files, undefined, markup);
    const form = requests.at(-1).body;
    assert.equal(form.get('complexity'), 'low');
    assert.equal(form.get('output_format'), 'gif');
    assert.equal(form.get('frame_count'), '4');
    assert.equal(form.has('input_fidelity'), false);
    assert.deepEqual(form.getAll('image[]').map(file => file.name), ['first.png', 'reference.png']);
    assert.deepEqual(Buffer.from(await form.get('markup').arrayBuffer()), markup.buffer);
  }
});

test('incompatible modes, stale fields and invalid frame/size settings are rejected', () => {
  const base = { model: models[0] };
  for (const [params, context] of [
    [{ format: 'svg', n: 2 }], [{ format: 'svg' }, { editing: true }],
    [{ format: 'gif', frame_count: 1 }], [{ format: 'gif', frame_count: 17 }],
    [{ format: 'gif', frame_duration_ms: 19 }], [{ format: 'gif', frame_duration_ms: 2001 }],
    [{ frame_count: 9 }], [{ format: 'gif', output_compression: 10 }],
    [{ format: 'jpeg', background: 'transparent' }], [{ complexity: 'max' }],
    [{ size: '1025x1024' }], [{ size: '512x512' }],
    [{ format: 'svg', svg_reasoning: 'high' }], [{ format: 'png', svg_model: 'some-model' }],
    [{ n: 'invalid' }], [{}, { hasMarkup: true }],
  ]) assert.throws(() => validateImageOptions({ ...base, ...params }, context));
  assert.doesNotThrow(() => validateImageOptions({ ...base, format: 'gif', size: '256x256', frame_count: 16, frame_duration_ms: 2000 }));
  assert.doesNotThrow(() => validateImageOptions({ ...base, format: 'svg', n: 1 }));
  assert.throws(() => validateImageOptions({ model: 'gpt-image-2.5-flare', format: 'gif' }));
});

test('2.6 estimates match the official calculator, including rounded Low and Medium corrections', async () => {
  const { estimateImage26Tokens, estimateImage26Price } = await import('../public/image-price.js');
  for (const [width, height, expected] of [[1024, 1024, [823, 1449, 1756, 3122, 7024]],
    [1536, 1024, [664, 1132, 1372, 2459, 5488]], [2048, 2048, [1667, 2944, 3568, 6343, 14272]]]) {
    for (const [i, quality] of ['low', 'medium', 'high', 'xhigh', 'max'].entries()) {
      assert.equal(estimateImage26Tokens(width, height, quality), expected[i]);
      assert.equal(estimateImage26Tokens(height, width, quality), expected[i]);
    }
  }
  assert.equal(estimateImage26Price('1024x1024', 'low', 'openai').minPerImage, 0.02469);
  assert.equal(estimateImage26Price('1024x1024', 'low', 'cometapi').minPerImage, 0.019752);
  assert.equal(estimateImage26Tokens(512, 512, 'low'), null);
  assert.equal(estimateImage26Price('auto', '').assumptions.length, 2);
});

test('markup validates oriented source dimensions, alpha pixels and compressed data', () => {
  const source = { buffer: png(16, 16, 255) };
  const data = buffer => ({ dataUrl: 'data:image/png;base64,' + buffer.toString('base64') });
  assert.deepEqual(validateMarkupImage(data(png(16, 16)), source).buffer, png(16, 16));
  assert.throws(() => validateMarkupImage(data(png(16, 16, 255)), source), /透過/);
  assert.throws(() => validateMarkupImage(data(png(32, 16)), source), /同じサイズ/);
  assert.throws(() => validateMarkupImage(data(Buffer.from('not a PNG')), source));
  assert.deepEqual(imageDimensions(png(32, 16)), { width: 32, height: 16 });
  const tiff = Buffer.from('49492a0008000000010012010300010000000600000000000000', 'hex');
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.alloc(exif.length + 4);
  app1.writeUInt16BE(0xffe1);
  app1.writeUInt16BE(exif.length + 2, 2);
  exif.copy(app1, 4);
  const jpeg = Buffer.concat([Buffer.from([255, 216]), app1, Buffer.from([255, 192, 0, 11, 8, 0, 16, 0, 32, 1, 1, 17, 0, 255, 217])]);
  assert.deepEqual(imageDimensions(jpeg), { width: 16, height: 32 });
  assert.doesNotThrow(() => validateMarkupImage(data(png(16, 32)), { buffer: jpeg }));
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(15, 24, 3); webp.writeUIntLE(31, 27, 3);
  assert.deepEqual(imageDimensions(webp), { width: 16, height: 32 });
});

async function historyWhen(app, count) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const { history } = await (await fetch(app.url + '/history')).json();
    if (history.length === count) return history;
    await delay(20);
  }
  assert.fail('Timed out waiting for history');
}

test('both providers persist SVG/GIF, markup, new options and usage and serve correct media types', async t => {
  const app = await createTestServer();
  t.after(app.close);
  let count = 0;
  for (const provider of ['cometapi', 'openai']) for (const format of ['svg', 'gif']) {
    const source = png(16, 16, 255);
    const markup = png(16, 16);
    const payload = { prompt: 'An animated lantern', params: { provider, model: models[0], format, complexity: 'low', n: 1,
      ...(format === 'gif' ? { frame_count: 4, frame_duration_ms: 100, size: '256x256' } : {}) },
      ...(format === 'gif' ? { inputImages: [{ dataUrl: 'data:image/png;base64,' + source.toString('base64') }],
        markupImage: { dataUrl: 'data:image/png;base64,' + markup.toString('base64') } } : {}) };
    const response = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 202, await response.text());
    const history = await historyWhen(app, ++count);
    const entry = history[0];
    assert.equal(entry.status, 'completed', entry.error);
    assert.equal(entry.params.provider, provider);
    assert.equal(entry.params.complexity, 'low');
    assert.equal(entry.usage.image.output_tokens, 823);
    const media = await fetch(app.url + entry.images[0]);
    assert.equal(media.headers.get('content-type'), format === 'gif' ? 'image/gif' : 'image/svg+xml');
    const bytes = Buffer.from(await media.arrayBuffer());
    if (format === 'svg') {
      assert.ok(bytes.toString().startsWith('<svg'));
      assert.ok(media.headers.get('content-security-policy').includes('sandbox'));
      assert.equal(entry.usage.svg.model, 'test-svg-author');
    } else {
      assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a');
      assert.equal(entry.params.frame_count, 4);
      assert.ok(entry.markupImage);
      assert.deepEqual(Buffer.from(await (await fetch(app.url + entry.markupImage)).arrayBuffer()), markup);
      assert.deepEqual(app.requests().at(-1).inputImages, [source.toString('base64')]);
      assert.equal(app.requests().at(-1).markup, markup.toString('base64'));
    }
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(app.root, 'history.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT markup_image, usage FROM entries').all();
    assert.equal(rows.filter(row => row.markup_image).length, 2);
    assert.ok(rows.every(row => JSON.parse(row.usage).image.output_tokens === 823));
  } finally { db.close(); }
});

test('invalid new options and markup fail before saving any inputs or calling a provider', async t => {
  const app = await createTestServer();
  t.after(app.close);
  for (const format of ['svg', 'png']) {
    const response = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'An edit', params: { model: models[0], provider: 'cometapi', format },
        inputImages: [{ dataUrl: 'data:image/png;base64,' + png(16, 16).toString('base64') }],
        markupImage: { dataUrl: 'data:image/png;base64,' + png(16, 16, 255).toString('base64') } }) });
    assert.equal(response.status, 400);
  }
  for (const inputImages of ['invalid', [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }], Array(17).fill({ dataUrl: 'data:image/png;base64,' + png(16, 16).toString('base64') })]) {
    const response = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'An edit', params: { model: models[0], provider: 'cometapi' }, inputImages }) });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(app.requests(), []);
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'public/images/inputs')), []);
});

test('API errors preserve the HTTP status without bypassing the configured retry limit', async t => {
  for (const status of [400, 403, 429, 503]) {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status, statusText: 'Test error', text: async () => '{"error":{"message":"Provider rejected the request"}}' }));
    await assert.rejects(callGenerations('A circle', { model: models[0], provider: 'cometapi' }), error => error.status === status && error.retryable === undefined);
    t.mock.restoreAll();
  }
});

test('generation loop respects the configured attempt limit for every HTTP error', async () => {
  for (const status of [400, 403, 429, 503]) {
    const entry = { id: 'retry-test', params: {}, images: [], status: 'queued' };
    const pendingEntries = new Map([[entry.id, entry]]);
    const abortControllers = new Map();
    const history = [];
    const saved = [];
    let calls = 0;
    const start = createStartGeneration({ MAX_RETRIES: 3, IMAGES_DIR: '.', isGeminiModel: () => false,
      callGenerations: async () => { calls++; throw Object.assign(new Error('Expected provider failure'), { status }); },
      dbSaveEntry: record => saved.push(record), broadcast: () => {}, pendingEntries, abortControllers, history });
    await start(entry.id, entry, 'A circle', { model: models[0] }, []);
    assert.equal(calls, 3);
    assert.equal(entry.status, 'error');
    assert.equal(saved.length, 1);
    assert.equal(history.length, 1);
    assert.equal(pendingEntries.size, 0);
    assert.equal(abortControllers.size, 0);
  }
});

test('CometAPI HTTP 400 retries through the server and succeeds on the tenth attempt', async t => {
  const app = await createTestServer({ maxRetries: 10, apiFailures: 9, apiFailureStatus: 400 });
  t.after(app.close);
  const response = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Retry regression test', params: { model: models[0], provider: 'cometapi' } }) });
  assert.equal(response.status, 202);
  const [entry] = await historyWhen(app, 1);
  assert.equal(entry.status, 'completed', entry.error);
  assert.equal(entry.retries, 9);
  assert.equal(app.requests().length, 10);
});

test('a custom retry limit stops repeated HTTP 400 failures at the configured count', async t => {
  const app = await createTestServer({ maxRetries: 3, apiFailures: 20, apiFailureStatus: 400 });
  t.after(app.close);
  const response = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Retry limit regression test', params: { model: models[0], provider: 'cometapi' } }) });
  assert.equal(response.status, 202);
  const [entry] = await historyWhen(app, 1);
  assert.equal(entry.status, 'error');
  assert.equal(entry.retries, 3);
  assert.equal(app.requests().length, 3);
});
