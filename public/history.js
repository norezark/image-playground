// history.js – 生成履歴のレンダリング

import { el } from './utils.js';
import { openLightbox } from './lightbox.js';
import { deleteEntry, cancelEntry, toggleFavorite } from './api.js';

const historyList = document.getElementById('historyList');

// script.js から loadParams / editWithImage コールバックを受け取る
let _loadParams = null;
let _editWithImage = null;
let _showFavoritesOnly = false;

const BORDER_COLOR_PALETTE = [
  '#8eaed6',
  '#d9b39f',
  '#9dbfa2',
  '#b9acd8',
  '#cdbf95',
  '#9fc7bf',
  '#d1a9b8',
  '#a6b7cf',
];

const _entryBorderColorMap = new Map();
let _nextBorderColorIndex = 0;
let _renderedTiles = new Map();
const _lazyImageObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries, observer) => {
      for (const observed of entries) {
        if (!observed.isIntersecting) continue;
        const img = observed.target;
        const src = img.dataset.src;
        if (src && img.src !== src) img.src = src;
        img.classList.remove('is-lazy');
        observer.unobserve(img);
      }
    }, {
      root: null,
      rootMargin: '220px 0px',
      threshold: 0.01,
    })
  : null;

function observeLazyImage(img) {
  if (_lazyImageObserver) {
    _lazyImageObserver.observe(img);
    return;
  }
  // Fallback for very old browsers: load immediately.
  img.src = img.dataset.src;
  img.classList.remove('is-lazy');
}

function getEntryBorderColor(entryId) {
  if (_entryBorderColorMap.has(entryId)) return _entryBorderColorMap.get(entryId);

  const color = BORDER_COLOR_PALETTE[_nextBorderColorIndex % BORDER_COLOR_PALETTE.length];
  _entryBorderColorMap.set(entryId, color);
  _nextBorderColorIndex += 1;
  return color;
}

export function initHistory(loadParams, editWithImage) {
  _loadParams = loadParams;
  _editWithImage = editWithImage;
}

export function setFavoritesFilter(enabled) {
  _showFavoritesOnly = enabled;
}

function buildTileSignature(entry, imgUrl, borderColor) {
  return JSON.stringify({
    id: entry.id,
    imgUrl: imgUrl ?? null,
    prompt: entry.prompt,
    timestamp: entry.timestamp ?? null,
    status: entry.status ?? null,
    retries: entry.retries ?? 0,
    error: entry.error ?? null,
    params: entry.params ?? {},
    inputImages: entry.inputImages ?? [],
    favoritedImages: entry.favoritedImages ?? [],
    borderColor,
  });
}

function getTileKey(entryId, imgUrl) {
  return `entry-${entryId}-${imgUrl ?? 'placeholder'}`;
}

// changedIds が渡された場合、そこに含まれないエントリはシグネチャ再計算（JSON.stringify）を
// スキップして既存タイルをそのまま再利用する。SSE イベントの都度、履歴全件分の
// シグネチャを再計算すると件数が多いときに負荷が高くなるための最適化。
export function renderHistory(entries, changedIds) {
  const all = Array.from(entries.values()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const nextRenderedTiles = new Map();
  let cursor = historyList.firstChild;

  const placeTile = (entry, imgUrl, borderColor) => {
    const key = getTileKey(entry.id, imgUrl);
    const prevCached = _renderedTiles.get(key);
    let node;

    if (changedIds && !changedIds.has(entry.id) && prevCached) {
      node = prevCached.node;
      nextRenderedTiles.set(key, prevCached);
    } else {
      const signature = buildTileSignature(entry, imgUrl, borderColor);
      node = prevCached && prevCached.signature === signature
        ? prevCached.node
        : renderImageTile(entry, imgUrl, borderColor);
      nextRenderedTiles.set(key, { signature, node });
    }

    if (node === cursor) {
      cursor = cursor.nextSibling;
      return;
    }
    historyList.insertBefore(node, cursor);
  };

  for (const entry of all) {
    if (entry.images?.length) {
      const borderColor = getEntryBorderColor(entry.id);
      entry.images.forEach(imgUrl => {
        if (_showFavoritesOnly && !entry.favoritedImages?.includes(imgUrl)) return;
        placeTile(entry, imgUrl, borderColor);
      });
    } else {
      if (!_showFavoritesOnly) placeTile(entry, null, getEntryBorderColor(entry.id));
    }
  }

  while (cursor) {
    const next = cursor.nextSibling;
    historyList.removeChild(cursor);
    cursor = next;
  }

  _renderedTiles = nextRenderedTiles;
}

function statusLabel(entry) {
  switch (entry.status) {
    case 'completed': return `Completed${entry.retries ? ` (retries: ${entry.retries})` : ''}`;
    case 'retrying':  return `Retrying (${entry.retries})`;
    case 'error':     return `Error (attempts: ${entry.retries || 1})`;
    default:          return 'Queued';
  }
}

function renderImageTile(entry, imgUrl, borderColor) {
  const status    = entry.status || (entry.images?.length ? 'completed' : entry.error ? 'error' : 'queued');
  const isPending = status === 'queued' || status === 'retrying';
  const paramsText = Object.entries(entry.params || {})
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // 画像エリア
  const tileImage = el('div', { class: 'tile-image' });
  if (imgUrl) {
    const historyImg = el('img', {
      class: 'is-lazy',
      src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      loading: 'lazy',
      decoding: 'async',
      onclick: () => openLightbox(imgUrl),
    });
    historyImg.dataset.src = imgUrl;
    observeLazyImage(historyImg);
    tileImage.appendChild(historyImg);
    tileImage.style.cursor = 'zoom-in';
    const isFav = !!entry.favoritedImages?.includes(imgUrl);
    const favBtn = el('button', {
      class: `fav-button${isFav ? ' is-favorited' : ''}`,
      title: isFav ? 'お気に入り解除' : 'お気に入りに追加',
      onclick: () => toggleFavorite(entry.id, imgUrl, !entry.favoritedImages?.includes(imgUrl)),
    });
    favBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    tileImage.appendChild(favBtn);
  } else if (status === 'completed') {
    tileImage.appendChild(el('div', { class: 'tile-error-overlay' }, [
      el('span', { class: 'tile-error-icon', text: '\u26A0' }),
      el('span', { class: 'tile-error-text', text: '画像データが保存されていません' }),
    ]));
  } else if (status === 'error' && entry.error) {
    tileImage.appendChild(el('div', { class: 'tile-error-overlay' }, [
      el('span', { class: 'tile-error-icon', text: '\u26A0' }),
      el('span', { class: 'tile-error-text', text: entry.error }),
    ]));
  } else if (isPending) {
    const children = [
      el('div', { class: 'spinner' }),
      el('span', { text: status === 'retrying' ? `リトライ中… (${entry.retries || 0}回目)` : '生成待機中…' }),
    ];
    if (status === 'retrying' && entry.error) {
      children.push(el('span', { class: 'tile-error-text', text: entry.error }));
    }
    tileImage.appendChild(el('div', { class: 'pending-placeholder' }, children));
  }

  // フッター
  const actionBtn = isPending
    ? el('button', { class: 'cancel-button', text: 'Cancel', onclick: () => cancelEntry(entry.id) })
    : el('button', { class: 'delete-button', text: 'Delete', onclick: () => deleteEntry(entry.id) });

  const inputImagesRow = Array.isArray(entry.inputImages) && entry.inputImages.length
    ? [el('div', { class: 'tile-input-images' },
        entry.inputImages.map(u => el('img', { class: 'tile-input-thumb', src: u, title: 'Input image' })))]
    : [];

  const tileFooter = el('div', { class: 'tile-footer' }, [
    el('div', { class: 'tile-prompt', text: entry.prompt }),
    ...inputImagesRow,
    el('div', { class: 'tile-meta' }, [
      el('span', { class: 'tile-params', text: paramsText }),
      el('span', { class: 'status', text: statusLabel(entry) }),
    ]),
    ...(entry.timestamp ? [el('div', { class: 'tile-timestamp', text: new Date(entry.timestamp).toLocaleString('ja-JP') })] : []),
    el('div', { class: 'tile-actions' }, [
      actionBtn,
      el('button', { class: 'load-button', text: 'Load', onclick: () => _loadParams?.(entry) }),
      ...(imgUrl ? [el('button', { class: 'edit-button', text: 'Edit', onclick: () => _editWithImage?.(imgUrl) })] : []),
    ]),
  ]);

  const tile = el('div', {
    class: `history-item${isPending ? ' is-pending' : ''}`,
    id: getTileKey(entry.id, imgUrl),
  }, [tileImage, tileFooter]);

  tile.style.setProperty('--entry-border-color', borderColor);
  return tile;
}
