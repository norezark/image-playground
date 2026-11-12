'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createTestServer } = require('./helpers/test-server.cjs');
const { createStartGeneration } = require('../lib/generation');

function device(id) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  return { subscription, decrypt(push) {
    const body = Buffer.from(push.body, 'base64');
    const salt = body.subarray(0, 16), keyEnd = 21 + body[20];
    const senderKey = body.subarray(21, keyEnd);
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const expand = (key, info, size) => hmac(key, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, size);
    const ikm = expand(hmac(auth, ecdh.computeSecret(senderKey)),
      Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderKey]), 32);
    const prk = hmac(salt, ikm);
    const decipher = crypto.createDecipheriv('aes-128-gcm', expand(prk, 'Content-Encoding: aes128gcm\0', 16), expand(prk, 'Content-Encoding: nonce\0', 12));
    decipher.setAuthTag(body.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(body.subarray(keyEnd, -16)), decipher.final()]);
    assert.equal(plaintext[plaintext.length - 1], 2);
    return JSON.parse(plaintext.subarray(0, -1));
  } };
}

const post = (url, path, body, origin = url) => fetch(url + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
});
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(20); }
  assert.fail('Timed out waiting for generation/push');
}

test('closed-page generation sends one decryptable notification to each registered PC/phone and supports test/unsubscribe', async t => {
  const app = await createTestServer();
  t.after(app.close);
  const pc = device('pc'), phone = device('phone');
  const phoneUrl = app.url.replace('localhost', '127.0.0.1');
  const configResponse = await fetch(app.url + '/push/config');
  assert.equal(configResponse.headers.get('access-control-allow-origin'), null);
  assert.equal(configResponse.headers.get('cache-control'), 'no-store');
  const config = await configResponse.json();
  assert.match(config.publicKey, /^[\w-]{87}$/);
  assert.deepEqual(Object.keys(config), ['publicKey']);
  assert.equal((await post(app.url, '/push/subscribe', { subscription: pc.subscription })).status, 200);
  assert.equal((await post(phoneUrl, '/push/subscribe', { subscription: phone.subscription })).status, 200);
  // No SSE/browser connection exists during generation.
  assert.equal((await post(app.url, '/generate', { prompt: 'Private prompt', params: { model: 'gpt-image-2' } })).status, 202);
  await until(() => app.pushes().length === 2);
  for (const [current, push] of [[pc, app.pushes().find(p => p.url === pc.subscription.endpoint)],
    [phone, app.pushes().find(p => p.url === phone.subscription.endpoint)]]) {
    const payload = current.decrypt(push);
    assert.equal(payload.title, '画像の生成が完了しました');
    assert.match(payload.url, /^\/#generation=[\w-]+$/);
    assert.equal(JSON.stringify(payload).includes('Private prompt'), false);
  }
  assert.equal((await post(app.url, '/push/test', { endpoint: pc.subscription.endpoint })).status, 200);
  assert.match(pc.decrypt(app.pushes()[2]).body, /テスト通知/);
  assert.equal((await post(app.url, '/push/unsubscribe', { endpoint: pc.subscription.endpoint })).status, 200);
  await post(app.url, '/generate', { prompt: 'Second', params: { model: 'gpt-image-2' } });
  await until(() => app.pushes().length === 4);
  assert.equal(app.pushes()[3].url, phone.subscription.endpoint);
  const manifest = await fetch(app.url + '/manifest.webmanifest');
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal((await manifest.json()).display, 'standalone');
  const worker = await fetch(app.url + '/sw.js');
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(app.url + '/icons/icon-192.png')).status, 200);
});

test('only terminal retry exhaustion sends a failure notification; recovered retries send completion', async t => {
  for (const [apiFailures, expectedTitle] of [[3, 'リトライ上限に達しました'], [2, '画像の生成が完了しました']]) {
    const app = await createTestServer({ maxRetries: 3, apiFailures });
    t.after(app.close);
    const pc = device(`retries-${apiFailures}`);
    await post(app.url, '/push/subscribe', { subscription: pc.subscription });
    await post(app.url, '/generate', { prompt: 'Retry test', params: { model: 'gpt-image-2' } });
    await until(() => app.pushes().length > 0);
    assert.equal(app.requests().length, 3);
    assert.equal(app.pushes().length, 1);
    assert.equal(pc.decrypt(app.pushes()[0]).title, expectedTitle);
    if (apiFailures === 3) assert.match(pc.decrypt(app.pushes()[0]).body, /3回/);
  }
});

test('push registration rejects cross-origin/missing-origin requests, oversized bodies and arbitrary endpoints', async t => {
  const app = await createTestServer();
  t.after(app.close);
  const subscription = device('blocked').subscription;
  for (const origin of ['https://other.example', 'null', app.url + '/path']) {
    assert.equal((await post(app.url, '/push/subscribe', { subscription }, origin)).status, 403);
  }
  assert.equal((await fetch(app.url + '/push/subscribe', { method: 'POST' })).status, 403);
  assert.equal((await fetch(app.url + '/push/subscribe', { method: 'OPTIONS', headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await post(app.url, '/push/subscribe', { subscription: { ...subscription, endpoint: 'https://127.0.0.1/private' } })).status, 400);
  assert.equal((await post(app.url, '/push/subscribe', { junk: 'x'.repeat(17000) })).status, 413);
  assert.equal(app.pushes().length, 0);
});

test('a rejected push cannot retry or change a successful image generation', async t => {
  const app = await createTestServer({ maxRetries: 3, pushStatus: 503 });
  t.after(app.close);
  const pc = device('push-unavailable');
  await post(app.url, '/push/subscribe', { subscription: pc.subscription });
  await post(app.url, '/generate', { prompt: 'Success despite push failure', params: { model: 'gpt-image-2' } });
  await until(() => app.pushes().length === 1);
  const { history } = await (await fetch(app.url + '/history')).json();
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].retries, 0);
  assert.equal(app.requests().length, 1);
});

function generationHarness(overrides = {}) {
  const entry = { id: 'unit', images: [], params: {}, status: 'queued' };
  const notifications = [], events = [], pendingEntries = new Map([[entry.id, entry]]), abortControllers = new Map();
  const args = { MAX_RETRIES: 3, IMAGES_DIR: '', isGeminiModel: () => false,
    callGenerations: async () => ({ data: [{ url: 'https://images.example/image.png' }] }),
    dbSaveEntry() {}, broadcast: event => events.push(event), pendingEntries, abortControllers, history: [],
    notifyGeneration: (current, reason) => notifications.push({ reason, status: current.status }), ...overrides };
  return { entry, notifications, events, pendingEntries, abortControllers, run: () => createStartGeneration(args)(entry.id, entry, 'test', entry.params, []) };
}

test('cancellation and preprocessing failure do not notify; a throwing notification never retries generation', async () => {
  let signal;
  let complete;
  const canceled = generationHarness({ callGenerations: (_prompt, _params, currentSignal) => {
    signal = currentSignal;
    return new Promise(resolve => { complete = resolve; });
  } });
  const running = canceled.run();
  canceled.abortControllers.get('unit').abort();
  canceled.pendingEntries.delete('unit');
  complete({ data: [{ url: 'https://images.example/canceled.png' }] });
  await running;
  assert.equal(signal.aborted, true);
  assert.deepEqual(canceled.notifications, []);
  const failed = generationHarness();
  failed.entry.params.remove_synthid = true;
  await failed.run();
  assert.equal(failed.entry.status, 'error');
  assert.deepEqual(failed.notifications, []);
  let calls = 0;
  const pushError = generationHarness({ callGenerations: async () => {
    calls++;
    return { data: [{ url: 'https://images.example/success.png' }] };
  }, notifyGeneration: () => { throw new Error('Cannot send'); } });
  await pushError.run();
  assert.equal(calls, 1);
  assert.equal(pushError.entry.status, 'completed');
});
