'use strict';
const crypto = require('node:crypto');

// RFC 8291 / RFC 8188: one aes128gcm record, at most 4096 bytes on the wire.
function encryptPayload(keys, payload, { salt = crypto.randomBytes(16), privateKey } = {}) {
  const receiver = Buffer.from(keys.p256dh, 'base64url');
  const auth = Buffer.from(keys.auth, 'base64url');
  const sender = crypto.createECDH('prime256v1');
  if (privateKey) sender.setPrivateKey(privateKey);
  else sender.generateKeys();
  const publicKey = sender.getPublicKey();
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, publicKey]);
  const ikm = crypto.hkdfSync('sha256', sender.computeSecret(receiver), auth, info, 32);
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plaintext = Buffer.from(payload);
  if (plaintext.length > 3993) throw new Error('通知が大きすぎます。');
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = publicKey.length;
  return Buffer.concat([header, publicKey, cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(), cipher.getAuthTag()]);
}

function publicApplicationKey(jwk) {
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
}

function vapidAuthorization(endpoint, jwk, subject) {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60 };
  if (subject) claims.sub = subject;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode(claims)}`;
  const signature = crypto.sign('sha256', Buffer.from(token), {
    key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `vapid t=${token}.${signature}, k=${publicApplicationKey(jwk)}`;
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) throw new Error('通知先が不正です。');
  const url = new URL(endpoint);
  // Browser-owned endpoints only; do not turn subscription registration into arbitrary server requests.
  const allowed = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || !allowed.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
    throw new Error('このブラウザの通知先には対応していません。');
  }
  return url.href;
}

function validateSubscription(subscription) {
  const endpoint = validateEndpoint(subscription?.endpoint);
  const keys = subscription?.keys;
  if (!keys || !/^[A-Za-z0-9_-]{87}={0,1}$/.test(keys.p256dh || '')
    || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(keys.auth || '')) throw new Error('通知の暗号鍵が不正です。');
  const publicKey = Buffer.from(keys.p256dh, 'base64url');
  if (publicKey.length !== 65 || publicKey[0] !== 4 || Buffer.from(keys.auth, 'base64url').length !== 16) {
    throw new Error('通知の暗号鍵が不正です。');
  }
  try { crypto.ECDH.convertKey(publicKey, 'prime256v1'); }
  catch { throw new Error('通知の公開鍵が不正です。'); }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function generationNotification(entry, reason) {
  if (reason === 'completed') return {
    title: '画像の生成が完了しました', body: `${entry.images?.length || 1}枚の画像を生成しました。タップして確認できます。`,
    tag: `generation-${entry.id}`, url: `/#generation=${encodeURIComponent(entry.id)}`,
  };
  if (reason === 'retry-limit') return {
    title: 'リトライ上限に達しました', body: `${entry.retries}回試行しましたが、画像を生成できませんでした。タップして詳細を確認できます。`,
    tag: `generation-${entry.id}`, url: `/#generation=${encodeURIComponent(entry.id)}`,
  };
  return null;
}

function createPushNotifications({ db, subject = process.env.WEB_PUSH_SUBJECT || '', fetchImpl = globalThis.fetch,
  onError = () => console.error('プッシュ通知を送信できませんでした。通知サービスへの接続とWEB_PUSH_SUBJECTを確認してください。') }) {
  if (subject && !/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(subject)) {
    throw new Error('WEB_PUSH_SUBJECT には連絡先のHTTPS URLまたは mailto:メールアドレスを設定してください。');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS push_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, origin TEXT NOT NULL);`);
  let jwk;
  function getKey() {
    if (!jwk) {
      let row = db.prepare("SELECT value FROM push_settings WHERE key = 'vapid'").get();
      if (!row) {
        const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        db.prepare("INSERT OR IGNORE INTO push_settings (key, value) VALUES ('vapid', ?)")
          .run(JSON.stringify(privateKey.export({ format: 'jwk' })));
        row = db.prepare("SELECT value FROM push_settings WHERE key = 'vapid'").get();
      }
      jwk = JSON.parse(row.value);
    }
    return jwk;
  }
  const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND origin = ?');
  const save = db.prepare('INSERT INTO push_subscriptions (endpoint, subscription, origin) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription, origin = excluded.origin');
  const list = db.prepare('SELECT subscription, origin FROM push_subscriptions');

  async function send(subscription, payload, origin) {
    const endpoint = validateEndpoint(subscription.endpoint);
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: vapidAuthorization(endpoint, getKey(), subject || (origin.startsWith('https:') ? origin : undefined)),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
      body: encryptPayload(subscription.keys, JSON.stringify(payload)),
    });
    // Drain the body so repeated notifications do not leave connections open.
    await response.arrayBuffer();
    if (response.status === 404 || response.status === 410) { remove.run(endpoint, origin); return false; }
    if (!response.ok) throw new Error(`Push service returned ${response.status}`);
    return true;
  }

  return {
    publicKey: () => publicApplicationKey(getKey()),
    subscribe(subscription, origin) {
      const normalized = validateSubscription(subscription);
      save.run(normalized.endpoint, JSON.stringify(normalized), origin);
    },
    unsubscribe(endpoint, origin) { remove.run(validateEndpoint(endpoint), origin); },
    async test(endpoint, origin) {
      const row = db.prepare('SELECT subscription FROM push_subscriptions WHERE endpoint = ? AND origin = ?').get(endpoint, origin);
      if (!row) throw new Error('この端末の通知登録が見つかりません。通知を有効にし直してください。');
      const delivered = await send(JSON.parse(row.subscription), {
        title: 'Image Playground', body: 'テスト通知です。生成完了・リトライ上限到達時にこの端末へ通知します。', tag: 'push-test', url: '/',
      }, origin);
      if (!delivered) throw new Error('通知登録の有効期限が切れています。通知を有効にし直してください。');
    },
    async notifyGeneration(entry, reason) {
      const payload = generationNotification(entry, reason);
      if (!payload) return;
      const subscriptions = list.all();
      // Bound fan-out while keeping a failed/unreachable device independent of other devices.
      for (let index = 0; index < subscriptions.length; index += 8) {
        await Promise.all(subscriptions.slice(index, index + 8).map(async row => {
          try { await send(JSON.parse(row.subscription), payload, row.origin); }
          catch { onError(); }
        }));
      }
    },
  };
}

module.exports = { createPushNotifications, encryptPayload, vapidAuthorization, validateSubscription, generationNotification };
