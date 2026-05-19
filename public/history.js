// history.js – 生成履歴のレンダリング

import { el } from './utils.js';
import { openLightbox } from './lightbox.js';
import { deleteEntry, cancelEntry } from './api.js';

const historyList = document.getElementById('historyList');

// script.js から loadParams コールバックを受け取る
let _loadParams = null;

export function initHistory(loadParams) {
  _loadParams = loadParams;
}

export function renderHistory(entries) {
  const sorted = Array.from(entries.values()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  historyList.innerHTML = '';
  for (const entry of sorted) {
    if (entry.images?.length) {
      entry.images.forEach(imgUrl => historyList.appendChild(renderImageTile(entry, imgUrl)));
    } else {
      historyList.appendChild(renderImageTile(entry, null));
    }
  }
}

function statusLabel(entry) {
  switch (entry.status) {
    case 'completed': return `Completed${entry.retries ? ` (retries: ${entry.retries})` : ''}`;
    case 'retrying':  return `Retrying (${entry.retries})`;
    case 'error':     return `Error (attempts: ${entry.retries || 1})`;
    default:          return 'Queued';
  }
}

function renderImageTile(entry, imgUrl) {
  const status    = entry.status || (entry.images?.length ? 'completed' : entry.error ? 'error' : 'queued');
  const isPending = status === 'queued' || status === 'retrying';
  const paramsText = Object.entries(entry.params || {})
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // 画像エリア
  const tileImage = el('div', { class: 'tile-image' });
  if (imgUrl) {
    tileImage.appendChild(el('img', { src: imgUrl, onclick: () => openLightbox(imgUrl) }));
    tileImage.style.cursor = 'zoom-in';
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
    el('div', { class: 'tile-actions' }, [
      actionBtn,
      el('button', { class: 'load-button', text: 'Load', onclick: () => _loadParams?.(entry) }),
    ]),
  ]);

  return el('div', {
    class: `history-item${isPending ? ' is-pending' : ''}`,
    id: `entry-${entry.id}-${imgUrl ?? 'placeholder'}`,
  }, [tileImage, tileFooter]);
}
