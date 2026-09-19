'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createImageStore } = require('../lib/image-store');
const { createSynthidPreprocessor } = require('../lib/synthid');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const tagged = tag => Buffer.concat([png, Buffer.from(tag)]);
const input = tag => ({ buffer: tagged(tag), mimeType: 'image/png', filename: `${tag}.png` });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cache-test-'));
  const dbPath = path.join(root, 'cache.db');
  const ctx = { root, db: new DatabaseSync(dbPath) };
  ctx.store = createImageStore(ctx);
  ctx.files = path.join(root, 'public/images/inputs');
  fs.mkdirSync(path.join(root, 'scripts'));
  ctx.worker = path.join(root, 'scripts/synthid-worker.py');
  fs.writeFileSync(ctx.worker, `
const fs = require('node:fs');
if (process.argv[2] === '--check') console.log(JSON.stringify({ available: true, version: '0.41.1' }));
else {
  const bytes = fs.readFileSync(process.argv[2]);
  fs.appendFileSync('calls.txt', 'worker\\n');
  if (bytes.includes(Buffer.from('fail'))) { console.error('Test input failed'); process.exit(1); }
  fs.writeFileSync('gpu.lock', 'busy', { flag: 'wx' });
  setTimeout(() => {
    fs.writeFileSync(process.argv[3], Buffer.concat([bytes, Buffer.from('processed')]));
    fs.unlinkSync('gpu.lock');
  }, bytes.includes(Buffer.from('slow')) ? 400 : 60);
}
`);
  ctx.processor = (options = {}) => createSynthidPreprocessor({ root, imageStore: ctx.store,
    python: process.execPath, timeoutMs: 5000, ...options });
  ctx.calls = () => fs.existsSync(path.join(root, 'calls.txt')) ? fs.readFileSync(path.join(root, 'calls.txt'), 'utf8').trim().split('\n').length : 0;
  ctx.reopen = () => {
    ctx.db.close();
    ctx.db = new DatabaseSync(dbPath);
    ctx.store = createImageStore(ctx);
  };
  t.after(() => {
    ctx.db.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('image-cache-test-')) throw new Error('Invalid cleanup path');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return ctx;
}

test('identical bytes share one input file, including differently named or labelled uploads', t => {
  const ctx = fixture(t);
  const first = ctx.store.put(png, 'image/png');
  assert.equal(ctx.store.put(png, 'image/jpeg').url, first.url);
  assert.equal(fs.readdirSync(ctx.files).length, 1);
  assert.deepEqual(fs.readFileSync(path.join(ctx.root, 'public', first.url)), png);
  assert.notEqual(ctx.store.put(tagged('different metadata')).url, first.url);
  assert.equal(fs.readdirSync(ctx.files).length, 2);
});

test('existing inputs and previous removal results are read in place without rewriting or deleting files/history', t => {
  const ctx = fixture(t);
  const files = { 'input-old.png': png, 'input-duplicate.png': png, 'preprocessed-old.png': tagged('result') };
  for (const [name, buffer] of Object.entries(files)) fs.writeFileSync(path.join(ctx.files, name), buffer);
  const history = [{ params: { remove_synthid: true }, inputImages: ['/images/inputs/input-old.png'], processedInputImages: ['/images/inputs/preprocessed-old.png'] }];
  const originalHistory = JSON.stringify(history);
  const mtimes = Object.fromEntries(Object.keys(files).map(name => [name, fs.statSync(path.join(ctx.files, name)).mtimeMs]));
  ctx.store.setHistory(history, 'recipe-1');
  assert.equal(ctx.store.cacheCount('recipe-1'), 0);
  const result = ctx.store.getPreprocessed(png, 'recipe-1');
  assert.equal(result.url, '/images/inputs/preprocessed-old.png');
  assert.ok(['/images/inputs/input-old.png', '/images/inputs/input-duplicate.png'].includes(ctx.store.put(png).url));
  assert.equal(JSON.stringify(history), originalHistory);
  assert.deepEqual(fs.readdirSync(ctx.files).sort(), Object.keys(files).sort());
  for (const [name, buffer] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(ctx.files, name)), buffer);
    assert.equal(fs.statSync(path.join(ctx.files, name)).mtimeMs, mtimes[name]);
  }
  ctx.reopen();
  ctx.store.setHistory(history, 'recipe-2');
  assert.equal(ctx.store.getPreprocessed(png, 'recipe-2'), null);
  assert.equal(ctx.store.getPreprocessed(png, 'recipe-1').url, result.url);
});

test('concurrent requests and repeated inputs perform removal once and retain image order', async t => {
  const ctx = fixture(t);
  const processor = ctx.processor();
  const a = input('a'), b = input('b');
  const [first, second] = await Promise.all([
    processor.processImages([a, a]), processor.processImages([a]),
  ]);
  assert.equal(ctx.calls(), 1);
  assert.equal(first[0].url, first[1].url);
  assert.equal(first[0].url, second[0].url);
  assert.equal([...first, ...second].filter(image => image.cacheHit).length, 2);
  const mixed = await processor.processImages([b, a, b]);
  assert.equal(ctx.calls(), 2);
  assert.deepEqual(mixed.map(image => image.buffer), [tagged('bprocessed'), tagged('aprocessed'), tagged('bprocessed')]);
  assert.deepEqual(mixed.map(image => image.cacheHit), [false, true, true]);
});

test('cache survives reopening the database and works without the Python runtime', async t => {
  const ctx = fixture(t);
  const a = input('persist');
  ctx.store.put(a.buffer);
  const [first] = await ctx.processor().processImages([a]);
  ctx.reopen();
  const processor = ctx.processor({ python: path.join(ctx.root, 'missing-python') });
  assert.equal(processor.areAllCached([a]), true);
  assert.deepEqual(await processor.getStatus(), { available: false,
    message: 'SynthID除去エンジン未設定。scripts/setup-synthid.ps1 を実行してください。', cachedImages: 1 });
  const [second] = await processor.processImages([a]);
  assert.equal(second.cacheHit, true);
  assert.equal(second.url, first.url);
  assert.equal(ctx.calls(), 1);
  assert.equal(fs.readdirSync(ctx.files).length, 2);
});

test('a worker recipe change invalidates removal results while keeping shared image storage', async t => {
  const ctx = fixture(t);
  const a = input('recipe');
  const processor = ctx.processor();
  await processor.processImages([a]);
  fs.appendFileSync(ctx.worker, '\n// new removal recipe\n');
  const changed = ctx.processor();
  assert.notEqual(changed.recipeKey, processor.recipeKey);
  assert.equal(changed.areAllCached([a]), false);
  assert.equal((await changed.processImages([a]))[0].cacheHit, false);
  assert.equal(ctx.calls(), 2);
  assert.equal(fs.readdirSync(ctx.files).length, 1);
});

test('a successful input stays cached when a later input fails', async t => {
  const ctx = fixture(t);
  const processor = ctx.processor();
  const good = input('good'), bad = input('fail');
  await assert.rejects(processor.processImages([good, bad]), /Test input failed/);
  assert.equal(processor.areAllCached([good]), true);
  assert.equal(processor.areAllCached([bad]), false);
  assert.equal((await processor.processImages([good]))[0].cacheHit, true);
  assert.equal(ctx.calls(), 2);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, '.synthid/jobs')), []);
});

test('Chroma precision separates result caches and rejects unsupported settings', async t => {
  const ctx = fixture(t);
  const image = input('precision');
  const nf4 = ctx.processor({ chromaPrecision: 'nf4' });
  const bf16 = ctx.processor({ chromaPrecision: 'bf16' });
  assert.notEqual(nf4.recipeKey, bf16.recipeKey);
  await nf4.processImages([image]);
  assert.equal(bf16.areAllCached([image]), false);
  await bf16.processImages([image]);
  assert.equal(nf4.areAllCached([image]), true);
  assert.equal(ctx.calls(), 2);
  assert.throws(() => ctx.processor({ chromaPrecision: 'unknown' }), /must be nf4 or bf16/);
});

test('timeout retains elapsed worker output after cleaning temporary images', async t => {
  const ctx = fixture(t);
  fs.writeFileSync(ctx.worker, `console.log('Loading Qwen NF4'); console.error('Running step 1/4'); setInterval(() => {}, 1000);`);
  await assert.rejects(ctx.processor({ timeoutMs: 1000 }).processImages([input('timeout')]), /タイムアウト[\s\S]*ログ:/);
  const logs = fs.readdirSync(path.join(ctx.root, '.synthid/logs'));
  assert.equal(logs.length, 1);
  const log = fs.readFileSync(path.join(ctx.root, '.synthid/logs', logs[0]), 'utf8');
  assert.match(log, /\[\d+\.\ds stdout\] Loading Qwen NF4/);
  assert.match(log, /Running step 1\/4/);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, '.synthid/jobs')), []);
  assert.equal(ctx.processor().areAllCached([input('timeout')]), false);
});

test('Qwen precision and helper changes invalidate the result cache', async t => {
  const ctx = fixture(t);
  const a = input('qwen');
  fs.writeFileSync(path.join(ctx.root, 'scripts/synthid_qwen.py'), '# first version');
  const nf4 = ctx.processor({ qwenPrecision: 'nf4' });
  await nf4.processImages([a]);
  const fp8 = ctx.processor({ qwenPrecision: 'fp8' });
  assert.notEqual(nf4.recipeKey, fp8.recipeKey);
  assert.equal(fp8.areAllCached([a]), false);
  fs.appendFileSync(path.join(ctx.root, 'scripts/synthid_qwen.py'), '\n# changed');
  assert.equal(ctx.processor({ qwenPrecision: 'nf4' }).areAllCached([a]), false);
  assert.throws(() => ctx.processor({ qwenPrecision: 'unknown' }), /must be nf4 or fp8/);
});

for (const mutation of ['missing', 'corrupted']) test(`${mutation} output is regenerated and never accepted again through previous history`, async t => {
  const ctx = fixture(t);
  const a = input(mutation);
  const original = ctx.store.put(a.buffer);
  const processor = ctx.processor();
  const [first] = await processor.processImages([a]);
  ctx.store.setHistory([{ params: { remove_synthid: true }, inputImages: [original.url], processedInputImages: [first.url] }], processor.recipeKey);
  const output = path.join(ctx.root, 'public', first.url);
  if (mutation === 'missing') fs.unlinkSync(output);
  else fs.writeFileSync(output, tagged('still a PNG, but wrong pixels'));
  assert.equal(processor.areAllCached([a]), false);
  assert.equal(processor.areAllCached([a]), false);
  assert.equal(ctx.store.cacheCount(processor.recipeKey), 0);
  const [second] = await processor.processImages([a]);
  assert.equal(ctx.calls(), 2);
  assert.equal(second.cacheHit, false);
  assert.deepEqual(second.buffer, tagged(mutation + 'processed'));
});

test('cached inputs bypass unrelated GPU work', async t => {
  const ctx = fixture(t);
  const processor = ctx.processor();
  await processor.processImages([input('cached')]);
  let finished = false;
  const busy = processor.processImages([input('slow')]).then(() => { finished = true; });
  const [cached] = await processor.processImages([input('cached')]);
  assert.equal(cached.cacheHit, true);
  assert.equal(finished, false);
  await busy;
});

test('cancelling a queued request does not cancel another request or release the GPU queue early', async t => {
  const ctx = fixture(t);
  const processor = ctx.processor();
  const active = processor.processImages([input('slow')]);
  const controller = new AbortController();
  const waiting = processor.processImages([input('cancelled')], { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const next = processor.processImages([input('next')]);
  await Promise.all([active, next]);
  assert.equal(ctx.calls(), 2);
  assert.equal(processor.areAllCached([input('cancelled')]), false);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, '.synthid/jobs')), []);
});
