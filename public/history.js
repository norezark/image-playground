// history.js – 生成履歴のレンダリング

import { el } from './utils.js';
import { createLazyImageLoader } from './lazy-images.js';
import { createHistoryRenderer } from './history-renderer.js';
import { stabilizeHistoryColumns } from './history-columns.js';
import { openLightbox } from './lightbox.js';
import { openParamsPopup } from './params-popup.js';
import { displayParams } from './model-selection.js';
import { deleteEntry, cancelEntry, toggleFavorite } from './api.js';

const historyList = document.getElementById('historyList');
stabilizeHistoryColumns(historyList);

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
const lazyImages = createLazyImageLoader();
const renderer = createHistoryRenderer({
  container: historyList,
  renderTile: (entry, imgUrl) => renderImageTile(entry, imgUrl, getEntryBorderColor(entry.id)),
  tileSignature: (entry, imgUrl) => buildTileSignature(entry, imgUrl, getEntryBorderColor(entry.id)),
  releaseTile: node => {
    for (const img of node.querySelectorAll('img[data-src]')) lazyImages.release(img);
  },
});

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
    processedInputImages: entry.processedInputImages ?? [],
    progress: entry.progress ?? null,
    favoritedImages: entry.favoritedImages ?? [],
    borderColor,
  });
}

function getTileKey(entryId, imgUrl) {
  return `entry-${entryId}-${imgUrl ?? 'placeholder'}`;
}

// 通常のSSE更新では全件の走査・並べ替え・DOM移動を行わない。
export function renderHistory(entries, changedIds) {
  renderer.render(entries, changedIds, _showFavoritesOnly);
}

function statusLabel(entry) {
  switch (entry.status) {
    case 'preprocessing': return 'SynthID前処理中';
    case 'generating': return 'Generating';
    case 'completed': return `Completed${entry.retries ? ` (retries: ${entry.retries})` : ''}`;
    case 'retrying':  return `Retrying (${entry.retries})`;
    case 'error':     return `Error (attempts: ${entry.retries || 1})`;
    default:          return 'Queued';
  }
}

function renderImageTile(entry, imgUrl, borderColor) {
  const status    = entry.status || (entry.images?.length ? 'completed' : entry.error ? 'error' : 'queued');
  const isPending = ['queued', 'retrying', 'preprocessing', 'generating'].includes(status);
  const paramsText = Object.entries(displayParams(entry.params))
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // 画像エリア
  const tileImage = el('div', { class: 'tile-image' });
  if (imgUrl) {
    const historyImg = lazyImages.create(imgUrl, {
      onclick: () => openLightbox(imgUrl, renderer.getVisibleImages()),
    });
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
      el('span', { text: status === 'retrying' ? `リトライ中… (${entry.retries || 0}回目)` : entry.progress || '生成待機中…' }),
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
        entry.inputImages.map(u => lazyImages.create(u, { class: 'tile-input-thumb', title: '元の入力画像',
          onclick: () => openLightbox(u, entry.inputImages), })))]
    : [];
  const processedImagesRow = entry.processedInputImages?.length
    ? [el('div', { class: 'tile-input-images' }, [
        el('span', { class: 'tile-input-label', text: '前処理後' }),
        ...entry.processedInputImages.map(u => lazyImages.create(u, { class: 'tile-input-thumb',
          title: '編集APIへ渡した画像（SynthID除去の成否は未検証）',
          onclick: () => openLightbox(u, entry.processedInputImages), })),
      ])] : [];

  const tileFooter = el('div', { class: 'tile-footer' }, [
    el('div', { class: 'tile-prompt', text: entry.prompt, title: 'クリックでパラメータ一覧を表示', onclick: () => openParamsPopup(entry) }),
    ...inputImagesRow,
    ...processedImagesRow,
    el('div', { class: 'tile-meta' }, [
      el('span', { class: 'tile-params', text: paramsText, title: 'クリックでパラメータ一覧を表示', onclick: () => openParamsPopup(entry) }),
      el('span', { class: 'status', text: statusLabel(entry) }),
    ]),
    ...(entry.timestamp ? [el('div', { class: 'tile-timestamp', text: new Date(entry.timestamp).toLocaleString('ja-JP') })] : []),
    el('div', { class: 'tile-actions' }, [
      actionBtn,
      el('button', { class: 'load-button', text: 'Load', onclick: () => _loadParams?.(entry) }),
      ...(imgUrl ? [el('button', { class: 'edit-button', text: 'Edit', onclick: () => _editWithImage?.(imgUrl, entry) })] : []),
    ]),
  ]);

  const tile = el('div', {
    class: `history-item${isPending ? ' is-pending' : ''}`,
    id: getTileKey(entry.id, imgUrl),
  }, [el('div', { class: 'tile-content' }, [tileImage, tileFooter])]);

  tile.style.setProperty('--entry-border-color', borderColor);
  return tile;
}
