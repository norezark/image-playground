// Push only: do not cache generation results or interfere with normal requests.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Always show a visible notification. */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'Image Playground', {
    body: payload.body || '生成の状態が更新されました。',
    tag: payload.tag,
    icon: '/icons/icon-192.png',
    data: { url: payload.url || '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || '/', self.location.origin);
    if (url.origin !== self.location.origin) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === url.origin) {
        const navigated = await client.navigate(url.href);
        if (navigated) { await navigated.focus(); return; }
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
