// Server-delivered Web Push, independent of the page's SSE connection.
export async function initPushNotifications() {
  const toggle = document.getElementById('pushToggle');
  const test = document.getElementById('pushTest');
  const status = document.getElementById('pushStatus');
  const state = document.getElementById('pushState');
  let registration;
  let subscription;
  let publicKey;
  let busy = false;

  function render(message) {
    state.textContent = subscription ? 'オン' : 'オフ';
    toggle.textContent = subscription ? 'この端末の通知をオフ' : 'この端末の通知を有効にする';
    toggle.disabled = busy;
    test.hidden = !subscription;
    test.disabled = busy;
    status.textContent = message || (subscription
      ? 'ページを閉じていても、この端末に通知します。'
      : '有効にすると、通知の許可を確認します。');
  }

  function unavailable(message) {
    state.textContent = '要設定';
    status.textContent = message;
    toggle.disabled = true;
    test.hidden = true;
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '通知の設定を保存できませんでした。');
    return data;
  }

  function decodeKey(value) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  }

  function hasCurrentKey(value) {
    const key = value.options?.applicationServerKey;
    return key && Array.from(new Uint8Array(key)).join(',') === Array.from(publicKey).join(',');
  }

  if (!window.isSecureContext) {
    unavailable('スマホ・別のPCからはHTTPSで開いてください。LANのHTTPでは通知を登録できません。このPCのlocalhostは利用できます。');
    return;
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone) {
    unavailable('iPhone・iPadでは、共有メニューから「ホーム画面に追加」し、そのアイコンから開いて通知を有効にしてください。');
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    unavailable('このブラウザではプッシュ通知を利用できません。対応するブラウザで開いてください。');
    return;
  }
  if (Notification.permission === 'denied') {
    unavailable('ブラウザのサイト設定で通知のブロックを解除してから、このページを再読み込みしてください。');
    return;
  }

  async function prepare() {
    const config = await request('/push/config');
    publicKey = decodeKey(config.publicKey);
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    let timeout;
    try {
      registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('通知の準備に時間がかかっています。再読み込みしてください。')), 12000); }),
      ]);
    } finally { clearTimeout(timeout); }
    const existing = await registration.pushManager.getSubscription();
    if (existing && !hasCurrentKey(existing)) {
      subscription = null;
      render('通知の登録を更新する必要があります。もう一度有効にしてください。');
    } else {
      if (existing) await request('/push/subscribe', { subscription: existing.toJSON() });
      subscription = existing;
      render();
    }
  }

  toggle.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render('通知を設定しています…');
    try {
      if (subscription) {
        // Keep the browser subscription available for another attempt if the server is unreachable.
        await request('/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        subscription = null;
      } else {
        // Call this before any await so iOS sees the original user gesture.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('通知が許可されませんでした。ブラウザのサイト設定から変更できます。');
        if (!registration) await prepare();
        const existing = await registration.pushManager.getSubscription();
        if (existing && !hasCurrentKey(existing)) await existing.unsubscribe();
        const next = existing && hasCurrentKey(existing) ? existing
          : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
        try { await request('/push/subscribe', { subscription: next.toJSON() }); }
        catch (error) { await next.unsubscribe(); throw error; }
        subscription = next;
      }
      render();
    } catch (error) {
      render(error.message || '通知を設定できませんでした。再度お試しください。');
    } finally { busy = false; toggle.disabled = false; test.disabled = false; }
  });

  test.addEventListener('click', async () => {
    if (busy || !subscription) return;
    busy = true;
    render('テスト通知を送信しています…');
    try {
      await request('/push/test', { endpoint: subscription.endpoint });
      render('テスト通知を送信しました。端末に届くことを確認してください。');
    } catch (error) { render(error.message); }
    finally { busy = false; toggle.disabled = false; test.disabled = false; }
  });

  busy = true;
  render('通知の設定を確認しています…');
  try { await prepare(); }
  catch { render('通知の設定を確認できませんでした。サーバーの起動状態を確認してから、ボタンで再度お試しください。'); }
  finally { busy = false; toggle.disabled = false; test.disabled = false; }
}
