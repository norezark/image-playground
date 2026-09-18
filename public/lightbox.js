// lightbox.js – ライトボックス（ズーム・パン・スワイプ）

const lightbox           = document.getElementById('lightbox');
const lightboxImg        = document.getElementById('lightboxImg');
const lightboxClose      = document.getElementById('lightboxClose');
const lightboxFullscreen = document.getElementById('lightboxFullscreen');

const ICON_EXPAND   = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="1em" height="1em" aria-hidden="true"><path d="M1.5 1.5h4v1.5H3V5.5H1.5zM14.5 1.5h-4v1.5H13V5.5H14.5zM1.5 14.5h4v-1.5H3V10.5H1.5zM14.5 14.5h-4v-1.5H13V10.5H14.5z"/></svg>`;
const ICON_COMPRESS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="1em" height="1em" aria-hidden="true"><path d="M4 1.5H5.5V5.5H1.5V4H4zM12 1.5H10.5V5.5H14.5V4H12zM4 14.5H5.5V10.5H1.5V12H4zM12 14.5H10.5V10.5H14.5V12H12z"/></svg>`;

function lbUpdateFullscreenBtn() {
  const isFs  = !!document.fullscreenElement;
  const label = isFs ? '全画面表示を終了' : '全画面表示';
  lightboxFullscreen.innerHTML = isFs ? ICON_COMPRESS : ICON_EXPAND;
  lightboxFullscreen.setAttribute('aria-label', label);
  lightboxFullscreen.title = label;
}

lightboxFullscreen.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!document.fullscreenElement) {
    lightbox.requestFullscreen().catch(err => console.warn('フルスクリーン要求失敗:', err));
  } else {
    document.exitFullscreen();
  }
});
document.addEventListener('fullscreenchange', lbUpdateFullscreenBtn);
lbUpdateFullscreenBtn();

// ---- ズーム / パン 状態 ----
let lbFitScale = 1;
let lbScale    = 1;
let lbX        = 0;
let lbY        = 0;
let lbImages   = [];
let lbIndex    = -1;

function lbApplyTransform() {
  lightboxImg.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbFitScale * lbScale})`;
}

function lbUpdateCursor() {
  lightboxImg.style.cursor = drag ? 'grabbing' : lbScale > SCALE_MIN || lbImages.length > 1 ? 'grab' : 'default';
}

function lbReset() {
  lbScale = 1; lbX = 0; lbY = 0;
  lbApplyTransform();
  lbUpdateCursor();
}

const SCALE_MIN = 1;
const SCALE_MAX = 10;

function lbZoomAt(delta, cx, cy) {
  const prev  = lbScale;
  lbScale     = Math.min(SCALE_MAX, Math.max(SCALE_MIN, lbScale * delta));
  const ratio = lbScale / prev;
  const rect  = lightbox.getBoundingClientRect();
  const ox    = cx - rect.left - rect.width  / 2;
  const oy    = cy - rect.top  - rect.height / 2;
  lbX = lbX * ratio + ox * (1 - ratio);
  lbY = lbY * ratio + oy * (1 - ratio);
  if (lbScale <= SCALE_MIN) { lbX = 0; lbY = 0; }
  lbApplyTransform();
  lbUpdateCursor();
}

function lbShowImage(src) {
  lbScale = 1; lbX = 0; lbY = 0; lbFitScale = 1;
  lightboxImg.style.transform = '';
  lbUpdateCursor();
  const applyFit = () => {
    const vw = lightbox.clientWidth;
    const vh = lightbox.clientHeight;
    lbFitScale = Math.min(vw / (lightboxImg.naturalWidth || vw), vh / (lightboxImg.naturalHeight || vh));
    lbApplyTransform();
  };
  lightboxImg.onload = applyFit;
  lightboxImg.src = src;
  if (lightboxImg.complete && lightboxImg.naturalWidth) applyFit();
}

export function openLightbox(src, images = [src]) {
  lbImages = images.slice();
  lbIndex = lbImages.indexOf(src);
  lbResetTouches();
  drag = null;
  clickFromDrag = false;
  suppressClickUntil = 0;
  lightbox.classList.add('is-open');
  document.body.style.overflow = 'hidden';
  lbShowImage(src);
  history.pushState({ lightbox: true }, '');
}

function lbNavigate(direction) {
  const next = lbIndex + direction;
  if (lbIndex < 0 || next < 0 || next >= lbImages.length) return;
  lbIndex = next;
  // 画像切り替えでは履歴を追加せず、戻る操作1回で閉じられるようにする。
  lbShowImage(lbImages[lbIndex]);
}

function lbSwipe(dx, dy) {
  if (lbScale <= SCALE_MIN && Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.25) {
    lbNavigate(dx < 0 ? 1 : -1);
  }
}

function closeLightbox() {
  lbResetTouches();
  drag = null;
  lbImages = [];
  lbIndex = -1;
  if (document.fullscreenElement) document.exitFullscreen();
  lightbox.classList.remove('is-open');
  document.body.style.overflow = '';
  setTimeout(() => { if (!lightbox.classList.contains('is-open')) lightboxImg.src = ''; }, 200);
}

// ---- ホイールズーム ----
lightbox.addEventListener('wheel', (e) => {
  e.preventDefault();
  lbZoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
}, { passive: false });

// ---- マウスドラッグ ----
let drag = null;
let clickFromDrag = false;
lightbox.addEventListener('mousedown', (e) => {
  clickFromDrag = false;
  if (e.button !== 0 || !lightbox.classList.contains('is-open') || e.target.closest('button')) return;
  // 画像自体のネイティブなドラッグを抑え、画像移動・切り替えに使う。
  e.preventDefault();
  drag = { startX: e.clientX, startY: e.clientY, x: lbX, y: lbY, canSwipe: lbScale <= SCALE_MIN };
  lbUpdateCursor();
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!(e.buttons & 1)) {
    drag = null;
    lbUpdateCursor();
    return;
  }
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (Math.hypot(dx, dy) > TAP_THRESHOLD) clickFromDrag = true;
  if (!drag.canSwipe) {
    lbX = drag.x + dx;
    lbY = drag.y + dy;
    lbApplyTransform();
  }
});
window.addEventListener('mouseup', (e) => {
  if (!drag || e.button !== 0) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  const canSwipe = drag.canSwipe;
  if (Math.hypot(dx, dy) > TAP_THRESHOLD) clickFromDrag = true;
  drag = null;
  if (canSwipe) lbSwipe(dx, dy);
  lbUpdateCursor();
});
window.addEventListener('blur', () => {
  drag = null;
  lbUpdateCursor();
});

// ---- タッチ: ピンチズーム + ドラッグ / 未ズーム時のスワイプ ----
let touches    = {};
let pinchDist0 = null;
let pinchScale0 = 1;
let pinchMidX  = 0;
let pinchMidY  = 0;
let touchDrag  = null;
let singleTouch = null;
let lastTap = 0, lastTapX = 0, lastTapY = 0;
let suppressClickUntil = 0;

const SWIPE_THRESHOLD = 50;
const TAP_THRESHOLD = 10;

function lbResetTouches() {
  touches = {};
  pinchDist0 = null;
  touchDrag = null;
  singleTouch = null;
  lastTap = 0;
}

const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const touchMid  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

lightbox.addEventListener('touchstart', (e) => {
  if (!lightbox.classList.contains('is-open') || e.target.closest('button')) return;
  Array.from(e.changedTouches).forEach(t => { touches[t.identifier] = t; });
  const pts = Object.values(touches);
  if (pts.length > 1) {
    // ピンチ後に1本指へ戻っても、そのジェスチャーをスワイプやタップにしない。
    singleTouch = null;
    lastTap = 0;
  } else if (pts.length === 1) {
    singleTouch = {
      identifier: pts[0].identifier,
      x: pts[0].clientX, y: pts[0].clientY,
      canSwipe: lbScale <= SCALE_MIN,
      moved: false,
    };
  }
  if (pts.length === 2) {
    pinchDist0  = touchDist(pts[0], pts[1]);
    pinchScale0 = lbScale;
    const mid   = touchMid(pts[0], pts[1]);
    pinchMidX = mid.x; pinchMidY = mid.y;
    touchDrag = null;
  } else if (pts.length === 1) {
    touchDrag = { startX: pts[0].clientX - lbX, startY: pts[0].clientY - lbY };
  }
}, { passive: true });

lightbox.addEventListener('touchmove', (e) => {
  Array.from(e.changedTouches).forEach(t => {
    if (t.identifier in touches) touches[t.identifier] = t;
  });
  const pts = Object.values(touches);
  if (singleTouch) {
    const t = touches[singleTouch.identifier];
    if (t && Math.hypot(t.clientX - singleTouch.x, t.clientY - singleTouch.y) > TAP_THRESHOLD) {
      singleTouch.moved = true;
      lastTap = 0;
      e.preventDefault();
    }
    if (lbScale > SCALE_MIN) singleTouch.canSwipe = false;
  }
  if (pts.length === 2 && pinchDist0 !== null) {
    e.preventDefault();
    const newDist = touchDist(pts[0], pts[1]);
    const scale   = Math.min(SCALE_MAX, Math.max(SCALE_MIN, pinchScale0 * (newDist / pinchDist0)));
    const ratio   = scale / lbScale;
    const rect    = lightbox.getBoundingClientRect();
    const ox = pinchMidX - rect.left - rect.width  / 2;
    const oy = pinchMidY - rect.top  - rect.height / 2;
    lbScale = scale;
    lbX = lbX * ratio + ox * (1 - ratio);
    lbY = lbY * ratio + oy * (1 - ratio);
    if (lbScale <= SCALE_MIN) { lbX = 0; lbY = 0; }
    lbApplyTransform();
  } else if (pts.length === 1 && touchDrag && lbScale > SCALE_MIN) {
    e.preventDefault();
    lbX = pts[0].clientX - touchDrag.startX;
    lbY = pts[0].clientY - touchDrag.startY;
    lbApplyTransform();
  }
}, { passive: false });

lightbox.addEventListener('touchend', (e) => {
  if (!Object.keys(touches).length) return;
  const gesture = singleTouch;
  const ended = Array.from(e.changedTouches).find(t => t.identifier === gesture?.identifier);
  Array.from(e.changedTouches).forEach(t => { delete touches[t.identifier]; });
  const pts = Object.values(touches);
  if (pts.length < 2) pinchDist0 = null;
  if (pts.length === 1) touchDrag = { startX: pts[0].clientX - lbX, startY: pts[0].clientY - lbY };
  if (pts.length > 0) return;
  touchDrag = null;
  singleTouch = null;

  const dx = ended ? ended.clientX - gesture.x : 0;
  const dy = ended ? ended.clientY - gesture.y : 0;
  const moved = gesture?.moved || Math.hypot(dx, dy) > TAP_THRESHOLD;
  if (!gesture || !ended || moved) {
    e.preventDefault();
    suppressClickUntil = Date.now() + 600;
    lastTap = 0;
    if (gesture?.canSwipe) lbSwipe(dx, dy);
    return;
  }

  const now = Date.now();
  if (lastTap && now - lastTap < 300 && Math.hypot(ended.clientX - lastTapX, ended.clientY - lastTapY) < 30) {
    e.preventDefault();
    lbToggleZoom(ended.clientX, ended.clientY);
    suppressClickUntil = now + 600;
    lastTap = 0;
  } else {
    lastTap = now; lastTapX = ended.clientX; lastTapY = ended.clientY;
  }
}, { passive: false });

lightbox.addEventListener('touchcancel', () => {
  lbResetTouches();
  suppressClickUntil = Date.now() + 600;
});

// ---- ダブルタップ / ダブルクリックでズームトグル ----
const DBL_ZOOM = 2;
function lbToggleZoom(cx, cy) {
  if (lbScale > SCALE_MIN) lbReset();
  else lbZoomAt(DBL_ZOOM, cx, cy);
}

lightbox.addEventListener('dblclick', (e) => {
  if (!clickFromDrag && !e.target.closest('button') && Date.now() >= suppressClickUntil) lbToggleZoom(e.clientX, e.clientY);
});

// ---- 閉じる ----
lightboxClose.addEventListener('click', () => history.back());

lightbox.addEventListener('click', (e) => {
  if (clickFromDrag) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.target === lightbox && Date.now() >= suppressClickUntil) history.back();
}, { capture: true });

window.addEventListener('popstate', () => {
  if (lightbox.classList.contains('is-open')) closeLightbox();
});
