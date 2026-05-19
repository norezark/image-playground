// script.js – エントリポイント・メインオーケストレーター

import { inputImages, renderInputThumbnails, clearInputImages, addInputImage } from './image-input.js';
import { computeResolution, sizeToSelects, setVisualGroup, updateSizeSelectors } from './size-selector.js';
import { updatePriceEstimate } from './price-estimate.js';
import { renderHistory, initHistory } from './history.js';
import { postJSON } from './api.js';
// lightbox は history.js 経由で自動初期化される

// ---- 共有状態 ----
// 生成エントリのマップ。キーは ID、値は { id, prompt, params, images, inputImages, timestamp, retries, status, error }
const entries = new Map();



// ---- 表示倍率トグル ----
const historyList = document.getElementById('historyList');
const fitToggle   = document.getElementById('fitToggle');
const savedFit    = localStorage.getItem('tile-fit') || 'cover';
historyList.dataset.fit = savedFit;
fitToggle.querySelectorAll('.fit-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.fit === savedFit);
  btn.addEventListener('click', () => {
    fitToggle.querySelectorAll('.fit-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    historyList.dataset.fit = btn.dataset.fit;
    localStorage.setItem('tile-fit', btn.dataset.fit);
  });
});



// ---- パラメータの復元 ----
async function loadParams(entry) {
  document.getElementById('prompt').value = entry.prompt;
  document.getElementById('model').value  = entry.params.model || 'gpt-image-2';
  document.getElementById('n').value      = entry.params.n || 1;

  const { orientation, ratio, tier } = sizeToSelects(entry.params.size);
  setVisualGroup('sizeOrientationGroup', 'sizeOrientation', orientation);
  setVisualGroup('sizeRatioGroup', 'sizeRatio', ratio);
  document.getElementById('sizeTier').value            = tier;
  updateSizeSelectors();

  document.getElementById('quality').value             = entry.params.quality            || '';
  document.getElementById('input_fidelity').value      = entry.params.input_fidelity     || '';
  document.getElementById('background').value          = entry.params.background         || '';
  document.getElementById('format').value              = entry.params.format             || '';
  document.getElementById('output_compression').value  = entry.params.output_compression ?? '';
  document.getElementById('moderation').value          = entry.params.moderation         || '';
  updatePriceEstimate();

  clearInputImages();
  if (Array.isArray(entry.inputImages) && entry.inputImages.length > 0) {
    await Promise.all(entry.inputImages.map(async (imgUrl) => {
      try {
        const res     = await fetch(imgUrl);
        const blob    = await res.blob();
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.readAsDataURL(blob);
        });
        addInputImage({ dataUrl, mimeType: blob.type, name: imgUrl.split('/').pop() });
      } catch (e) {
        console.warn('入力画像の再読み込み失敗', imgUrl, e);
      }
    }));
  }
  renderInputThumbnails();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// history.js に loadParams コールバックを登録
initHistory(loadParams);

// ---- フォーム送信 ----
document.getElementById('generateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;

  const sizeValue = computeResolution(
    document.getElementById('sizeOrientation').value,
    document.getElementById('sizeRatio').value,
    document.getElementById('sizeTier').value,
  );
  if (!sizeValue) { alert('選択した組み合わせで有効な解像度を計算できませんでした。'); return; }

  const params = {
    model:              document.getElementById('model').value,
    n:                  document.getElementById('n').value,
    size:               sizeValue,
    quality:            document.getElementById('quality').value,
    input_fidelity:     document.getElementById('input_fidelity').value,
    background:         document.getElementById('background').value,
    format:             document.getElementById('format').value,
    output_compression: document.getElementById('output_compression').value,
    moderation:         document.getElementById('moderation').value,
  };

  try {
    await postJSON('/generate', { prompt, params, inputImages: inputImages.length ? inputImages : undefined });
    document.getElementById('prompt').value = '';
    clearInputImages();
    renderInputThumbnails();
  } catch (err) {
    console.error('生成リクエスト失敗', err);
    alert('生成リクエストの送信に失敗しました: ' + err.message);
  }
});

// ---- 同期ステータス ----
const syncStatusEl = document.getElementById('syncStatus');
function setSyncStatus(state) {
  const labels = { connecting: '接続中…', online: '同期中', offline: '切断' };
  syncStatusEl.textContent = labels[state] ?? state;
  syncStatusEl.className   = `sync-status sync-${state}`;
}

// ---- SSE サブスクライブ ----
let _evtSource = null;
let _reconnectTimer = null;
let _heartbeatTimer = null;
const HEARTBEAT_TIMEOUT = 15000; // サーバーの送信間隔 10s + バッファ 5s

function resetHeartbeatTimer() {
  clearTimeout(_heartbeatTimer);
  _heartbeatTimer = setTimeout(() => {
    console.warn('ハートビートタイムアウト — 再接続します');
    if (_evtSource) { _evtSource.close(); _evtSource = null; }
    setSyncStatus('offline');
    _reconnectTimer = setTimeout(subscribe, 2000);
  }, HEARTBEAT_TIMEOUT);
}

function subscribe() {
  if (_evtSource) { _evtSource.close(); _evtSource = null; }
  clearTimeout(_reconnectTimer);
  clearTimeout(_heartbeatTimer);

  setSyncStatus('connecting');
  const evtSource = new EventSource('/events');
  _evtSource = evtSource;

  evtSource.addEventListener('init', (ev) => {
    resetHeartbeatTimer();
    try {
      const msg = JSON.parse(ev.data);
      entries.clear();
      for (const entry of (msg.history || [])) entries.set(entry.id, entry);
      for (const entry of (msg.pending || [])) entries.set(entry.id, entry);
      renderHistory(entries);
      setSyncStatus('online');
    } catch (err) {
      console.error('init メッセージの解析失敗', err);
    }
  });

  evtSource.addEventListener('update', (ev) => {
    resetHeartbeatTimer();
    try { handleUpdate(JSON.parse(ev.data)); }
    catch (err) { console.error('update メッセージの解析失敗', err); }
  });

  evtSource.addEventListener('heartbeat', resetHeartbeatTimer);

  evtSource.onerror = () => {
    clearTimeout(_heartbeatTimer);
    setSyncStatus('offline');
    evtSource.close();
    _evtSource = null;
    _reconnectTimer = setTimeout(subscribe, 2000);
  };
}

function handleUpdate(message) {
  switch (message.type) {
    case 'queued':
      entries.set(message.entry.id, message.entry);
      break;
    case 'retry': {
      const entry = entries.get(message.id);
      if (entry) { entry.retries = message.retries; entry.error = message.error; entry.status = 'retrying'; }
      break;
    }
    case 'completed':
      entries.set(message.entry.id, message.entry);
      break;
    case 'cancelled':
      entries.delete(message.id);
      break;
    case 'error':
      if (message.entry) {
        entries.set(message.entry.id, message.entry);
      } else {
        const entry = entries.get(message.id);
        if (entry) { entry.error = message.error; entry.status = 'error'; }
      }
      break;
    case 'deleted':
      entries.delete(message.id);
      break;
    default:
      console.warn('不明なメッセージタイプ', message);
  }
  renderHistory(entries);
}

// ---- 初期化 ----
updateSizeSelectors(); // updatePriceEstimate() も内部で呼ばれる
window.addEventListener('load', subscribe);

