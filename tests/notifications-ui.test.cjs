'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui({ secure = true, ios = false, denied = false, subscribed = false, rotated = false, failSave = false } = {}) {
  const elements = Object.fromEntries(['pushToggle', 'pushTest', 'pushStatus', 'pushState'].map(id => [id, {
    disabled: true, hidden: id === 'pushTest', handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
  }]));
  const calls = [];
  const key = Buffer.alloc(65, 4);
  let current;
  const makeSubscription = applicationKey => ({ endpoint: 'https://fcm.googleapis.com/test',
    options: { applicationServerKey: Uint8Array.from(applicationKey).buffer },
    toJSON() { return { endpoint: this.endpoint, keys: { auth: 'test', p256dh: 'test' } }; },
    async unsubscribe() { calls.push('unsubscribe'); current = null; return true; },
  });
  if (subscribed) current = makeSubscription(rotated ? Buffer.alloc(65, 5) : key);
  const registration = { pushManager: {
    getSubscription: async () => current,
    subscribe: async options => { calls.push('subscribe'); current = makeSubscription(options.applicationServerKey); return current; },
  } };
  const context = { Uint8Array, atob: value => Buffer.from(value, 'base64').toString('binary'), setTimeout, clearTimeout, AbortSignal,
    window: { isSecureContext: secure, PushManager: function () {}, Notification: function () {}, matchMedia: () => ({ matches: false }) },
    navigator: { userAgent: ios ? 'iPhone' : 'Desktop', platform: '', maxTouchPoints: 0,
      serviceWorker: { register: async () => { calls.push('register'); }, ready: Promise.resolve(registration) } },
    document: { getElementById: id => elements[id] },
    Notification: { permission: denied ? 'denied' : 'default', requestPermission: () => { calls.push('permission'); return Promise.resolve('granted'); } },
    fetch: async (url, options) => {
      calls.push(url);
      const failed = failSave && url === '/push/subscribe';
      return { ok: !failed, json: async () => url === '/push/config' ? { publicKey: key.toString('base64url') }
        : failed ? { error: 'Server unavailable' } : { status: 'ok' } };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/notifications.js'), 'utf8').replace('export async function', 'async function'), context);
  return { elements, calls, initialize: () => context.initPushNotifications(), click: id => elements[id].handlers.click() };
}

test('LAN HTTP, non-installed iOS and blocked permission show actionable guidance without registering', async () => {
  for (const [options, message] of [[{ secure: false }, /HTTPS/], [{ ios: true }, /ホーム画面に追加/], [{ denied: true }, /ブロック/]]) {
    const app = ui(options);
    await app.initialize();
    assert.match(app.elements.pushStatus.textContent, message);
    assert.equal(app.elements.pushToggle.disabled, true);
    assert.equal(app.calls.length, 0);
  }
});

test('permission is requested directly in the click; registration, test and unsubscribe update this device only', async () => {
  const app = ui();
  await app.initialize();
  assert.equal(app.elements.pushState.textContent, 'オフ');
  app.calls.length = 0;
  const enabled = app.click('pushToggle');
  assert.equal(app.calls[0], 'permission');
  await enabled;
  assert.equal(app.elements.pushState.textContent, 'オン');
  assert.equal(app.elements.pushTest.disabled, false);
  assert.equal(app.elements.pushTest.hidden, false);
  assert.ok(app.calls.indexOf('subscribe') < app.calls.indexOf('/push/subscribe'));
  await app.click('pushTest');
  assert.match(app.elements.pushStatus.textContent, /送信しました/);
  await app.click('pushToggle');
  assert.equal(app.elements.pushState.textContent, 'オフ');
  assert.ok(app.calls.indexOf('/push/unsubscribe') < app.calls.indexOf('unsubscribe'));
});

test('a saved device resynchronizes and its test button is enabled after initialization', async () => {
  const app = ui({ subscribed: true });
  await app.initialize();
  assert.ok(app.calls.includes('/push/subscribe'));
  assert.equal(app.elements.pushState.textContent, 'オン');
  assert.equal(app.elements.pushTest.disabled, false);
  assert.equal(app.elements.pushToggle.disabled, false);
});

test('rotated application keys require a user action and a failed save never reports notifications as enabled', async () => {
  const rotated = ui({ subscribed: true, rotated: true });
  await rotated.initialize();
  assert.equal(rotated.calls.includes('unsubscribe'), false);
  assert.match(rotated.elements.pushStatus.textContent, /更新/);
  await rotated.click('pushToggle');
  assert.ok(rotated.calls.indexOf('unsubscribe') < rotated.calls.indexOf('subscribe'));
  assert.equal(rotated.elements.pushState.textContent, 'オン');
  const unavailable = ui({ failSave: true });
  await unavailable.initialize();
  await unavailable.click('pushToggle');
  assert.equal(unavailable.elements.pushState.textContent, 'オフ');
  assert.equal(unavailable.calls.includes('unsubscribe'), true);
  assert.match(unavailable.elements.pushStatus.textContent, /Server unavailable/);
});

test('the service worker displays push without a page and opens only a same-origin generation URL', async () => {
  const handlers = {}, displayed = [], opened = [];
  const context = { URL, self: { location: { origin: 'https://playground.example' },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    registration: { showNotification: async (title, options) => displayed.push({ title, options }) },
    clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8'), context);
  let done;
  handlers.push({ data: { json: () => ({ title: '完了', body: '1枚', url: '/#generation=one' }) }, waitUntil: promise => { done = promise; } });
  await done;
  assert.equal(displayed[0].title, '完了');
  assert.equal(displayed[0].options.data.url, '/#generation=one');
  for (const url of ['/#generation=one', 'https://unrelated.example']) {
    handlers.notificationclick({ notification: { data: { url }, close() {} }, waitUntil: promise => { done = promise; } });
    await done;
  }
  assert.deepEqual(opened, ['https://playground.example/#generation=one']);
  handlers.push({ data: { json: () => { throw new Error('Invalid payload'); } }, waitUntil: promise => { done = promise; } });
  await done;
  assert.equal(displayed[1].title, 'Image Playground');
});
