// script.js – エントリポイント・メインオーケストレーター

import { inputImages, renderInputThumbnails, clearInputImages, addInputImage } from './image-input.js';
import { computeResolution, computeGeminiAspectRatio, sizeToSelects, setVisualGroup, updateSizeSelectors } from './size-selector.js';
import { updatePriceEstimate } from './price-estimate.js';
import { renderHistory, initHistory, setFavoritesFilter } from './history.js';
import { postJSON } from './api.js';
// lightbox は history.js 経由で自動初期化される

// ---- 共有状態 ----
// 生成エントリのマップ。キーは ID、値は { id, prompt, params, images, inputImages, timestamp, retries, status, error }
const entries = new Map();

// ---- Gemini モデル判定 ----
const GEMINI_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
function isGeminiModel(model) { return GEMINI_MODELS.has(model); }

const COMET_ONLY_PARAM_IDS = [
  'qualityLabel', 'inputFidelityLabel', 'backgroundLabel',
  'formatLabel', 'compressionLabel', 'moderationLabel',
];

const GEMINI_3_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
function isGemini3Model(model) { return GEMINI_3_MODELS.has(model); }

function updateModelSpecificUI() {
  const model    = document.getElementById('model').value;
  const isGemini = isGeminiModel(model);
  for (const id of COMET_ONLY_PARAM_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = isGemini ? 'none' : '';
  }
  const geminiSizeLabel = document.getElementById('geminiImageSizeLabel');
  if (geminiSizeLabel) {
    geminiSizeLabel.style.display = (isGemini && model !== 'gemini-2.5-flash-image') ? '' : 'none';
  }
  document.getElementById('geminiTemperatureLabel').style.display  = isGemini ? '' : 'none';
  document.getElementById('geminiTopPLabel').style.display          = isGemini ? '' : 'none';
  document.getElementById('geminiOutputFormatLabel').style.display  = isGemini ? '' : 'none';
  document.getElementById('geminiThinkingLevelLabel').style.display = isGemini3Model(model) ? '' : 'none';
  document.getElementById('geminiGroundingWebLabel').style.display  = isGemini3Model(model) ? '' : 'none';
  const isFlash31 = model === 'gemini-3.1-flash-image-preview';
  document.getElementById('geminiGroundingImageLabel').style.display = isFlash31 ? '' : 'none';
  if (!isFlash31) document.getElementById('gemini_grounding_image').checked = false;
  if (!isGemini3Model(model)) {
    document.getElementById('gemini_grounding_web').checked = false;
  }
  // Gemini 非対応のアスペクト比ボタンを切り替える
  document.querySelectorAll('#sizeRatioGroup .vis-btn[data-no-gemini]').forEach(btn => {
    btn.style.display = isGemini ? 'none' : '';
    if (isGemini && btn.classList.contains('active')) {
      setVisualGroup('sizeRatioGroup', 'sizeRatio', '4:3');
    }
  });
  // sizeTierLabel の表示状態をモデルに合わせて再評価する（Gemini では常に非表示）
  updateSizeSelectors();
}

// ---- Gemini スライダーと数値入力の同期 ----
function syncSlider(sliderId, numId) {
  const slider = document.getElementById(sliderId);
  const num    = document.getElementById(numId);
  slider.addEventListener('input', () => { num.value = slider.value; });
  num.addEventListener('input', () => {
    const v = Math.min(Number(num.max), Math.max(Number(num.min), Number(num.value)));
    slider.value = v;
    num.value    = v;
  });
}
syncSlider('gemini_temperature', 'gemini_temperature_num');
syncSlider('gemini_top_p',       'gemini_top_p_num');

document.getElementById('model').addEventListener('change', updateModelSpecificUI);
updateModelSpecificUI();

// ---- プロンプト入力欄のオートグロー（スマホ向け） ----
const promptTextarea = document.getElementById('prompt');
function autoGrowPrompt() {
  promptTextarea.style.height = 'auto';
  promptTextarea.style.height = promptTextarea.scrollHeight + 'px';
}
promptTextarea.addEventListener('input', autoGrowPrompt);



function _favFilterHtml(active) {
  return `<svg viewBox="0 0 24 24" width="11" height="11" fill="${active ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" style="vertical-align:-1px"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> お気に入り`;
}

// ---- お気に入りフィルタートグル ----
const favFilterBtn = document.getElementById('favFilterBtn');
favFilterBtn.addEventListener('click', () => {
  const enabled = favFilterBtn.classList.toggle('active');
  favFilterBtn.innerHTML = _favFilterHtml(enabled);
  setFavoritesFilter(enabled);
  renderHistory(entries);
});

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
  autoGrowPrompt();
  document.getElementById('model').value  = entry.params.model || 'gpt-image-2';
  document.getElementById('n').value      = entry.params.n || 1;

  let orientation, ratio, tier;
  if (isGeminiModel(entry.params.model)) {
    const ar = entry.params.gemini_aspect_ratio;
    if (!ar) {
      orientation = 'auto'; ratio = '4:3'; tier = 'S';
    } else if (ar === '1:1') {
      orientation = 'square'; ratio = '4:3'; tier = 'S';
    } else {
      const REVERSE_AR = {
        '5:4':  { orientation: 'landscape', ratio: '5:4'  },
        '4:5':  { orientation: 'portrait',  ratio: '5:4'  },
        '4:3':  { orientation: 'landscape', ratio: '4:3'  },
        '3:4':  { orientation: 'portrait',  ratio: '4:3'  },
        '3:2':  { orientation: 'landscape', ratio: '3:2'  },
        '2:3':  { orientation: 'portrait',  ratio: '3:2'  },
        '16:9': { orientation: 'landscape', ratio: '16:9' },
        '9:16': { orientation: 'portrait',  ratio: '16:9' },
        '21:9': { orientation: 'landscape', ratio: '21:9' },
      };
      ({ orientation = 'auto', ratio = '4:3' } = REVERSE_AR[ar] || {});
      tier = 'S';
    }
  } else {
    ({ orientation, ratio, tier } = sizeToSelects(entry.params.size));
  }
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
  document.getElementById('gemini_image_size').value          = entry.params.gemini_image_size    || '1K';
  const savedTemp = entry.params.gemini_temperature ?? 1;
  document.getElementById('gemini_temperature').value         = savedTemp;
  document.getElementById('gemini_temperature_num').value     = savedTemp;
  const savedTopP = entry.params.gemini_top_p ?? 0.95;
  document.getElementById('gemini_top_p').value               = savedTopP;
  document.getElementById('gemini_top_p_num').value           = savedTopP;
  document.getElementById('gemini_thinking_level').value      = entry.params.gemini_thinking_level || '';
  document.getElementById('gemini_output_format').value        = entry.params.gemini_output_format  || 'IMAGE_ONLY';
  document.getElementById('gemini_grounding_web').checked      = !!entry.params.gemini_grounding_web;
  document.getElementById('gemini_grounding_image').checked    = !!entry.params.gemini_grounding_image;
  updateModelSpecificUI();

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

// ---- 生成結果画像を入力として編集開始 ----
async function editWithImage(imgUrl) {
  clearInputImages();
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
    console.warn('画像の読み込み失敗', imgUrl, e);
  }
  renderInputThumbnails();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// history.js に loadParams / editWithImage コールバックを登録
initHistory(loadParams, editWithImage);

// ---- Ctrl+Enter で生成 ----
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    document.getElementById('generateForm').requestSubmit();
  }
});

// ---- フォーム送信 ----
document.getElementById('generateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;

  const orientation = document.getElementById('sizeOrientation').value;
  const ratio       = document.getElementById('sizeRatio').value;
  const tier        = document.getElementById('sizeTier').value;
  const model       = document.getElementById('model').value;

  if (isGeminiModel(model)) {
    // Gemini API: size は aspect_ratio + image_size で指定
    const geminiAspectRatio = computeGeminiAspectRatio(orientation, ratio);
    const geminiTemp         = document.getElementById('gemini_temperature_num').value;
    const geminiTopP          = document.getElementById('gemini_top_p_num').value;
    const geminiThinkingLevel = document.getElementById('gemini_thinking_level').value;
    const params = {
      model,
      n:                    document.getElementById('n').value,
      gemini_aspect_ratio:  geminiAspectRatio,
      gemini_image_size:    document.getElementById('gemini_image_size').value,
      gemini_temperature:   geminiTemp   !== '' ? Number(geminiTemp)   : undefined,
      gemini_top_p:         geminiTopP   !== '' ? Number(geminiTopP)   : undefined,
      gemini_thinking_level: (isGemini3Model(model) && geminiThinkingLevel) ? geminiThinkingLevel : undefined,
      gemini_output_format:  document.getElementById('gemini_output_format').value || 'IMAGE_ONLY',
      gemini_grounding_web:  isGemini3Model(model) ? document.getElementById('gemini_grounding_web').checked : false,
      gemini_grounding_image: (model === 'gemini-3.1-flash-image-preview') ? document.getElementById('gemini_grounding_image').checked : false,
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
    return;
  }

  const sizeValue = computeResolution(orientation, ratio, tier);
  if (!sizeValue) { alert('選択した組み合わせで有効な解像度を計算できませんでした。'); return; }

  const params = {
    model,
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
const syncClockEl  = document.getElementById('syncClock');
function setSyncStatus(state) {
  const labels = { connecting: '接続中…', online: '同期中', offline: '切断' };
  syncStatusEl.textContent = labels[state] ?? state;
  syncStatusEl.className   = `sync-status sync-${state}`;
}

function setSyncClock(isoString) {
  if (!syncClockEl) return;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    syncClockEl.textContent = '--:--:--';
    return;
  }
  syncClockEl.textContent = date.toLocaleTimeString('ja-JP', { hour12: false });
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
  setSyncClock(undefined);
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

  evtSource.addEventListener('clock', (ev) => {
    resetHeartbeatTimer();
    try {
      const msg = JSON.parse(ev.data || '{}');
      setSyncClock(msg.iso);
    } catch (err) {
      console.error('clock メッセージの解析失敗', err);
    }
  });

  evtSource.onerror = () => {
    clearTimeout(_heartbeatTimer);
    setSyncStatus('offline');
    evtSource.close();
    _evtSource = null;
    _reconnectTimer = setTimeout(subscribe, 2000);
  };
}

function handleUpdate(message) {
  const changedIds = new Set();
  switch (message.type) {
    case 'queued':
      entries.set(message.entry.id, message.entry);
      changedIds.add(message.entry.id);
      break;
    case 'retry': {
      const entry = entries.get(message.id);
      if (entry) { entry.retries = message.retries; entry.error = message.error; entry.status = 'retrying'; }
      changedIds.add(message.id);
      break;
    }
    case 'completed':
      entries.set(message.entry.id, message.entry);
      changedIds.add(message.entry.id);
      break;
    case 'cancelled':
      entries.delete(message.id);
      changedIds.add(message.id);
      break;
    case 'error':
      if (message.entry) {
        entries.set(message.entry.id, message.entry);
      } else {
        const entry = entries.get(message.id);
        if (entry) { entry.error = message.error; entry.status = 'error'; }
      }
      changedIds.add(message.id ?? message.entry?.id);
      break;
    case 'deleted':
      entries.delete(message.id);
      changedIds.add(message.id);
      break;
    case 'favorited': {
      const entry = entries.get(message.id);
      if (entry) {
        entry.favoritedImages = entry.favoritedImages || [];
        if (message.favorited) {
          if (!entry.favoritedImages.includes(message.imgUrl)) entry.favoritedImages.push(message.imgUrl);
        } else {
          entry.favoritedImages = entry.favoritedImages.filter(u => u !== message.imgUrl);
        }
      }
      changedIds.add(message.id);
      break;
    }
    default:
      console.warn('不明なメッセージタイプ', message);
  }
  renderHistory(entries, changedIds);
}

// ---- 初期化 ----
updateSizeSelectors(); // updatePriceEstimate() も内部で呼ばれる
window.addEventListener('load', subscribe);

