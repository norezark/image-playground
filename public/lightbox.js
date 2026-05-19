// lightbox.js – ライトボックス（ズーム・パン・タッチ操作）

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

function lbApplyTransform() {
  lightboxImg.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbFitScale * lbScale})`;
}

function lbReset() {
  lbScale = 1; lbX = 0; lbY = 0;
  lbApplyTransform();
  lightboxImg.style.cursor = 'default';
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
  lightboxImg.style.cursor = lbScale > 1 ? 'grab' : 'default';
}

export function openLightbox(src) {
  lbScale = 1; lbX = 0; lbY = 0; lbFitScale = 1;
  lightboxImg.style.transform = '';
  lightboxImg.style.cursor    = 'default';
  lightboxImg.src = src;
  lightbox.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  const applyFit = () => {
    const vw = lightbox.clientWidth;
    const vh = lightbox.clientHeight;
    lbFitScale = Math.min(vw / (lightboxImg.naturalWidth || vw), vh / (lightboxImg.naturalHeight || vh));
    lbApplyTransform();
  };
  if (lightboxImg.complete && lightboxImg.naturalWidth) applyFit();
  else lightboxImg.onload = applyFit;

  history.pushState({ lightbox: true }, '');
}

function closeLightbox() {
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
lightbox.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || lbScale <= SCALE_MIN) return;
  e.preventDefault();
  drag = { startX: e.clientX - lbX, startY: e.clientY - lbY };
  lightboxImg.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  lbX = e.clientX - drag.startX;
  lbY = e.clientY - drag.startY;
  lbApplyTransform();
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  lightboxImg.style.cursor = lbScale > 1 ? 'grab' : 'default';
});

// ---- タッチ: ピンチズーム + ドラッグ ----
let touches    = {};
let pinchDist0 = null;
let pinchScale0 = 1;
let pinchMidX  = 0;
let pinchMidY  = 0;
let touchDrag  = null;

const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const touchMid  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

lightbox.addEventListener('touchstart', (e) => {
  Array.from(e.changedTouches).forEach(t => { touches[t.identifier] = t; });
  const pts = Object.values(touches);
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
  Array.from(e.changedTouches).forEach(t => { touches[t.identifier] = t; });
  const pts = Object.values(touches);
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
  Array.from(e.changedTouches).forEach(t => { delete touches[t.identifier]; });
  const pts = Object.values(touches);
  if (pts.length < 2) pinchDist0 = null;
  if (pts.length === 1) touchDrag = { startX: pts[0].clientX - lbX, startY: pts[0].clientY - lbY };
  if (pts.length === 0) touchDrag = null;
}, { passive: true });

// ---- ダブルタップ / ダブルクリックでズームトグル ----
const DBL_ZOOM = 2;
function lbToggleZoom(cx, cy) {
  if (lbScale > SCALE_MIN) lbReset();
  else lbZoomAt(DBL_ZOOM, cx, cy);
}

let lastTap = 0, lastTapX = 0, lastTapY = 0, suppressDblClick = false;
lightbox.addEventListener('touchend', (e) => {
  if (Object.keys(touches).length > 0) return;
  const now = Date.now();
  const t   = e.changedTouches[0];
  if (now - lastTap < 300) {
    lbToggleZoom(lastTapX, lastTapY);
    suppressDblClick = true;
    setTimeout(() => { suppressDblClick = false; }, 600);
  }
  lastTap = now; lastTapX = t.clientX; lastTapY = t.clientY;
}, { passive: true });

lightbox.addEventListener('dblclick', (e) => {
  if (!suppressDblClick) lbToggleZoom(e.clientX, e.clientY);
});

// ---- 閉じる ----
lightboxClose.addEventListener('click', () => history.back());

let clickFromDrag = false;
lightbox.addEventListener('mousedown', () => { clickFromDrag = false; });
window.addEventListener('mousemove', () => { if (drag) clickFromDrag = true; });
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox && !clickFromDrag) history.back();
  clickFromDrag = false;
});

window.addEventListener('popstate', () => {
  if (lightbox.classList.contains('is-open')) closeLightbox();
});
