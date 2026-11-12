'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPushNotifications, encryptPayload, vapidAuthorization, validateSubscription, generationNotification } = require('../lib/web-push');

function subscriber(id = 'test') {
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

test('aes128gcm encryption matches the published RFC 8291 example byte for byte', () => {
  const encrypted = encryptPayload({
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, 'When I grow up, I want to be a watermelon', {
    salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
  });
  assert.equal(encrypted.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID JWT has a verifiable ES256 signature, push-service audience and bounded expiry', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/test', privateKey.export({ format: 'jwk' }), 'mailto:owner@example.com');
  const token = header.match(/^vapid t=([^,]+), k=([\w-]+)$/)[1];
  const [alg, claims, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(JSON.parse(Buffer.from(alg, 'base64url')).alg, 'ES256');
  assert.equal(decoded.aud, 'https://fcm.googleapis.com');
  assert.equal(decoded.sub, 'mailto:owner@example.com');
  assert.ok(decoded.exp > Date.now() / 1000 && decoded.exp < Date.now() / 1000 + 86400);
  assert.equal(crypto.verify('sha256', Buffer.from(`${alg}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
});

test('subscriptions reject arbitrary hosts, credentials, insecure endpoints and invalid EC keys', () => {
  const subscription = subscriber();
  for (const endpoint of ['http://fcm.googleapis.com/test', 'https://127.0.0.1/test', 'https://example.com/test',
    'https://fcm.googleapis.com.attacker.test/x', 'https://user@fcm.googleapis.com/test', 'https://fcm.googleapis.com:8443/test']) {
    assert.throws(() => validateSubscription({ ...subscription, endpoint }));
  }
  assert.throws(() => validateSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } }));
  assert.throws(() => validateSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'invalid' } }));
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns.notify.windows.com']) {
    assert.equal(new URL(validateSubscription({ ...subscription, endpoint: `https://${host}/test` }).endpoint).hostname, host);
  }
});

test('keys and device subscriptions persist, duplicate registration is idempotent, and 404/410 remove expired devices', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response('', { status: url.endsWith('expired') ? 410 : url.endsWith('missing') ? 404 : 201 });
  };
  const push = createPushNotifications({ db, fetchImpl });
  const key = push.publicKey();
  const resumed = createPushNotifications({ db, fetchImpl });
  assert.equal(resumed.publicKey(), key);
  for (const id of ['pc', 'phone', 'expired', 'missing']) {
    push.subscribe(subscriber(id), 'https://playground.example');
  }
  const phone = subscriber('phone');
  resumed.subscribe(phone, 'https://playground.example');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 4);
  await resumed.notifyGeneration({ id: 'one', images: ['one.png'] }, 'completed');
  assert.equal(requests.length, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 2);
  for (const { options } of requests) {
    assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(options.headers.Urgency, 'high');
    assert.equal(options.redirect, 'error');
    assert.ok(options.body.length <= 4096);
    assert.equal(options.body.includes(Buffer.from('画像の生成')), false);
    const claims = options.headers.Authorization.split('t=')[1].split('.')[1];
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).sub, 'https://playground.example');
  }
  resumed.unsubscribe(phone.endpoint, 'https://other.example');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 2);
  resumed.unsubscribe(phone.endpoint, 'https://playground.example');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 1);
});

test('one device or temporary push-service failure does not prevent delivery to another device', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const delivered = [];
  let errors = 0;
  const push = createPushNotifications({ db, onError: () => errors++, fetchImpl: async url => {
    if (url.endsWith('offline')) throw new Error('Network unavailable');
    if (url.endsWith('busy')) return new Response('', { status: 503 });
    delivered.push(url);
    return new Response('', { status: 201 });
  } });
  for (const id of ['offline', 'busy', 'pc']) push.subscribe(subscriber(id), 'http://localhost:8000');
  await push.notifyGeneration({ id: 'failed', retries: 3 }, 'retry-limit');
  assert.equal(delivered.length, 1);
  assert.equal(errors, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 3);
  await assert.rejects(push.test('https://fcm.googleapis.com/fcm/send/pc', 'https://other.example'));
  await push.test('https://fcm.googleapis.com/fcm/send/pc', 'http://localhost:8000');
});

test('notification contents omit prompts, provider errors and keys, and ignore nonterminal events', () => {
  const entry = { id: 'example', retries: 10, prompt: 'private prompt', error: 'secret provider error', images: ['a', 'b'] };
  assert.equal(generationNotification(entry, 'retry'), null);
  assert.equal(generationNotification(entry, 'cancelled'), null);
  assert.match(generationNotification(entry, 'completed').body, /2枚/);
  const failed = generationNotification(entry, 'retry-limit');
  assert.match(failed.body, /10回/);
  assert.equal(failed.url, '/#generation=example');
  assert.equal(JSON.stringify(failed).includes('private'), false);
  assert.equal(JSON.stringify(failed).includes('secret'), false);
});
