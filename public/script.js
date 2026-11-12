// script.js – エントリポイント・メインオーケストレーター

import { inputImages, renderInputThumbnails, clearInputImages, addInputImage, blobToInputImage, getInputRevision } from './image-input.js';
import { computeResolution, computeGeminiAspectRatio, sizeToSelects, setVisualGroup, updateSizeSelectors } from './size-selector.js';
import { updatePriceEstimate } from './price-estimate.js';
import { renderHistory, initHistory, setFavoritesFilter } from './history.js';
import { createHistoryRenderScheduler } from './history-renderer.js';
import { initParamsPopup } from './params-popup.js';
import { postJSON } from './api.js';
import { initPushNotifications } from './notifications.js';
import { parseModelSelection, modelSelectionValue, PROVIDER_LABELS, getImageModelCapabilities, validateImageOptions } from './model-selection.js';
// lightbox は history.js 経由で自動初期化される

// ---- 共有状態 ----
// 生成エントリのマップ。キーは ID、値は { id, prompt, params, images, inputImages, timestamp, retries, status, error }
const entries = new Map();
const scheduleHistoryRender = createHistoryRenderScheduler(changedIds => renderHistory(entries, changedIds));
let providerAvailability = null;
let synthidAvailability = null;
const synthidCheckbox = document.getElementById('remove_synthid');
const modelSelect = document.getElementById('model');
const savedModel = localStorage.getItem('image-model-selection');
if (savedModel && Array.from(modelSelect.options).some(option => option.value === savedModel)) {
  modelSelect.value = savedModel;
}

function updateProviderStatus() {
  const { provider } = parseModelSelection(modelSelect.value);
  const status = document.getElementById('providerStatus');
  const available = providerAvailability?.[provider] === true;
  status.hidden = available;
  status.textContent = providerAvailability
    ? `${PROVIDER_LABELS[provider]} のAPIキーが未設定です。キーの設定とサーバーの再起動が必要です。`
    : '接続先の設定を確認中…（表示が続く場合はサーバーを再起動してください）';
  const preprocessingUnavailable = inputImages.length > 0 && synthidCheckbox.checked && !canUseSynthid();
  document.getElementById('generateButton').disabled = !available || preprocessingUnavailable;
}

function canUseSynthid() { return synthidAvailability?.available || synthidAvailability?.cachedImages > 0; }

function updateSynthidOption() {
  synthidCheckbox.disabled = inputImages.length === 0 || (!canUseSynthid() && !synthidCheckbox.checked);
  document.getElementById('synthidStatus').textContent = !synthidAvailability
    ? '除去エンジンを確認中…'
    : !synthidAvailability.available ? (canUseSynthid() ? '保存済みの除去結果だけを再利用できます。新しい画像の除去にはエンジンの準備が必要です。' : synthidAvailability.message)
    : inputImages.length === 0 ? '入力画像を追加すると選択できます。'
    : '同じ入力画像の保存済み結果を自動で再利用します。初回はモデルのダウンロードと除去処理を行います。';
  updateProviderStatus();
}
synthidCheckbox.addEventListener('change', updateSynthidOption);
window.addEventListener('input-images-changed', updateSynthidOption);
fetch('/synthid/status', { signal: AbortSignal.timeout(65000) })
  .then(response => { if (!response.ok) throw new Error('status'); return response.json(); })
  .then(status => { synthidAvailability = status; updateSynthidOption(); })
  .catch(() => {
    synthidAvailability = { available: false, message: '除去エンジンを確認できません。サーバー更新後に再読み込みしてください。' };
    updateSynthidOption();
  });

// ---- Gemini モデル判定 ----
const GEMINI_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
function isGeminiModel(model) { return GEMINI_MODELS.has(model); }

const IMAGE_API_PARAM_IDS = [
  'qualityLabel', 'inputFidelityLabel', 'backgroundLabel',
  'formatLabel', 'compressionLabel', 'moderationLabel',
];

const GEMINI_3_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
function isGemini3Model(model) { return GEMINI_3_MODELS.has(model); }

function updateModelSpecificUI() {
  const { model } = parseModelSelection(modelSelect.value);
  const isGemini = isGeminiModel(model);
  const caps = getImageModelCapabilities(model);
  const editing = inputImages.length > 0;
  const quality = document.getElementById('quality');
  for (const option of quality.querySelectorAll('[data-extended-quality]')) {
    option.hidden = option.disabled = !caps.extendedQuality;
  }
  if (!caps.extendedQuality && ['xhigh', 'max'].includes(quality.value)) quality.value = '';
  for (const id of IMAGE_API_PARAM_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = isGemini ? 'none' : '';
  }
  const format = document.getElementById('format');
  for (const option of format.querySelectorAll('[data-image-26-only]')) {
    option.hidden = option.disabled = !caps.image26 || (option.value === 'svg' && editing);
  }
  if (!caps.formats.includes(format.value || 'png') || (editing && format.value === 'svg')) format.value = '';
  const svg = caps.image26 && format.value === 'svg';
  const gif = caps.image26 && format.value === 'gif';
  const compression = !isGemini && ['jpeg', 'webp'].includes(format.value);
  document.getElementById('complexityLabel').style.display = caps.complexity ? '' : 'none';
  if (!caps.complexity) document.getElementById('complexity').value = '';
  document.getElementById('inputFidelityLabel').style.display = !isGemini && caps.inputFidelity && editing ? '' : 'none';
  if (!caps.inputFidelity) document.getElementById('input_fidelity').value = '';
  document.getElementById('compressionLabel').style.display = compression ? '' : 'none';
  if (!compression) document.getElementById('output_compression').value = '';
  for (const option of document.getElementById('background').querySelectorAll('[data-transparency]')) {
    option.hidden = option.disabled = !caps.transparency;
  }
  const background = document.getElementById('background');
  if ((!caps.transparency && ['auto', 'transparent'].includes(background.value))
    || (background.value === 'transparent' && !['', 'png', 'webp'].includes(format.value))) background.value = 'opaque';
  document.getElementById('frameCountLabel').style.display = gif ? '' : 'none';
  document.getElementById('frameDurationLabel').style.display = gif ? '' : 'none';
  document.getElementById('svgModelLabel').style.display = svg ? '' : 'none';
  document.getElementById('svgReasoningLabel').style.display = svg ? '' : 'none';
  const n = document.getElementById('n');
  n.disabled = svg;
  n.max = svg ? '1' : '10';
  if (svg) n.value = '1';
  const hint = document.getElementById('formatHint');
  hint.hidden = !svg && !gif;
  hint.textContent = svg ? 'SVGは新規生成1枚に対応します。画像出力料金に加え、SVG作成モデルの料金がかかります。作成モデルの指定は利用権限がある場合のみ設定してください。'
    : gif ? 'GIFは静止画を参照して生成できます。サイズはAutoを推奨します。フレーム数・サイズ・生成枚数によって生成可能な上限が変わります。' : '';
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
  updateProviderStatus();
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

modelSelect.addEventListener('change', () => {
  localStorage.setItem('image-model-selection', modelSelect.value);
  updateModelSpecificUI();
  renderInputThumbnails();
});
window.addEventListener('input-images-changed', updateModelSpecificUI);
document.getElementById('format').addEventListener('change', () => {
  if (document.getElementById('format').value === 'gif') setVisualGroup('sizeOrientationGroup', 'sizeOrientation', 'auto');
  updateModelSpecificUI();
});
document.getElementById('background').addEventListener('change', updateModelSpecificUI);
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
  scheduleHistoryRender();
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
// includePrompt=false の場合、prompt 欄は変更しない（Edit ボタンから呼び出す場合に使用）
function applyEntryParams(entry, { includePrompt = true } = {}) {
  if (includePrompt) {
    document.getElementById('prompt').value = entry.prompt;
    autoGrowPrompt();
  }
  modelSelect.value = modelSelectionValue(entry.params);
  document.getElementById('format').value = entry.params.format || '';
  localStorage.setItem('image-model-selection', modelSelect.value);
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
  for (const [key, fallback] of [['complexity', ''], ['frame_count', 9], ['frame_duration_ms', 200], ['svg_model', ''], ['svg_reasoning', '']]) {
    document.getElementById(key).value = entry.params[key] ?? fallback;
  }
  synthidCheckbox.checked = entry.params.remove_synthid === true;
  updateSynthidOption();
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
}

async function loadInputImagesFromUrls(imgUrls, markupUrl) {
  clearInputImages();
  const revision = getInputRevision();
  const images = await Promise.all(imgUrls.map(async (imgUrl) => {
    const res = await fetch(imgUrl);
    if (!res.ok) throw new Error('履歴の入力画像を読み込めませんでした。');
    return blobToInputImage(await res.blob(), imgUrl.split('/').pop());
  }));
  if (markupUrl && images.length) {
    const res = await fetch(markupUrl);
    if (!res.ok) throw new Error('履歴の描き込みを読み込めませんでした。');
    images[0].markupDataUrl = (await blobToInputImage(await res.blob(), 'markup.png')).dataUrl;
  }
  if (revision !== getInputRevision()) return;
  images.forEach(addInputImage);
  renderInputThumbnails();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadParams(entry) {
  clearInputImages();
  applyEntryParams(entry, { includePrompt: true });
  try { await loadInputImagesFromUrls(Array.isArray(entry.inputImages) ? entry.inputImages : [], entry.markupImage); }
  catch (error) { renderInputThumbnails(); alert(error.message); }
}

// ---- 生成結果画像を入力として編集開始（prompt 以外のパラメータも Load する）----
async function editWithImage(imgUrl, entry) {
  clearInputImages();
  if (entry) applyEntryParams(entry, { includePrompt: false });
  try { await loadInputImagesFromUrls([imgUrl]); }
  catch (error) { renderInputThumbnails(); alert(error.message); }
}

// history.js に loadParams / editWithImage コールバックを登録
initHistory(loadParams, editWithImage);

// ---- プロンプトのみロード（パラメータポップアップの「プロンプトのみロード」ボタンから呼び出し）----
function loadPromptOnly(entry) {
  document.getElementById('prompt').value = entry.prompt;
  autoGrowPrompt();
}

// params-popup.js に loadPromptOnly コールバックを登録
initParamsPopup(loadPromptOnly);

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
  if (document.getElementById('generateButton').disabled) return;
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;

  const orientation = document.getElementById('sizeOrientation').value;
  const ratio       = document.getElementById('sizeRatio').value;
  const tier        = document.getElementById('sizeTier').value;
  const selection = parseModelSelection(modelSelect.value);
  const { model, provider } = selection;
  const preprocessingParams = inputImages.length && synthidCheckbox.checked ? { remove_synthid: true } : {};

  if (isGeminiModel(model)) {
    // Gemini API: size は aspect_ratio + image_size で指定
    const geminiAspectRatio = computeGeminiAspectRatio(orientation, ratio);
    const geminiTemp         = document.getElementById('gemini_temperature_num').value;
    const geminiTopP          = document.getElementById('gemini_top_p_num').value;
    const geminiThinkingLevel = document.getElementById('gemini_thinking_level').value;
    const params = {
      ...preprocessingParams,
      provider,
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

  const format = document.getElementById('format').value;
  const sizeValue = computeResolution(orientation, ratio, tier, { ...selection, format });
  if (!sizeValue) { alert('選択した組み合わせで有効な解像度を計算できませんでした。'); return; }

  const params = {
    ...preprocessingParams,
    provider,
    model,
    n:                  document.getElementById('n').value,
    size:               sizeValue,
    quality:            document.getElementById('quality').value,
    input_fidelity:     document.getElementById('input_fidelity').value,
    background:         document.getElementById('background').value,
    format,
    output_compression: document.getElementById('output_compression').value,
    moderation:         document.getElementById('moderation').value,
    complexity:         document.getElementById('complexity').value,
    ...(format === 'gif' ? { frame_count: document.getElementById('frame_count').value,
      frame_duration_ms: document.getElementById('frame_duration_ms').value } : {}),
    ...(format === 'svg' ? { svg_model: document.getElementById('svg_model').value.trim(),
      svg_reasoning: document.getElementById('svg_reasoning').value } : {}),
  };
  const markupData = getImageModelCapabilities(model).markup && inputImages[0]?.markupDataUrl;

  try {
    validateImageOptions(params, { editing: !!inputImages.length, hasMarkup: !!markupData });
    await postJSON('/generate', { prompt, params, inputImages: inputImages.length ? inputImages.map(({ dataUrl, mimeType, name }) => ({ dataUrl, mimeType, name })) : undefined,
      markupImage: markupData ? { dataUrl: markupData } : undefined });
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
let revealedGeneration = null;
function revealNotificationGeneration() {
  const hash = location.hash;
  const id = new URLSearchParams(hash.slice(1)).get('generation');
  if (!id || id === revealedGeneration) return;
  requestAnimationFrame(() => {
    if (location.hash !== hash) return;
    const tile = document.querySelector(`[id^="entry-${CSS.escape(id)}-"]`);
    if (tile) {
      revealedGeneration = id;
      tile.scrollIntoView({ block: 'center', behavior: 'smooth' });
      tile.classList.add('notification-target');
      setTimeout(() => tile.classList.remove('notification-target'), 5000);
      window.history.replaceState(window.history.state, '', location.pathname + location.search);
    }
  });
}
window.addEventListener('hashchange', () => { revealedGeneration = null; revealNotificationGeneration(); });

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
      providerAvailability = msg.providers || null;
      updateProviderStatus();
      entries.clear();
      for (const entry of (msg.history || [])) entries.set(entry.id, entry);
      for (const entry of (msg.pending || [])) entries.set(entry.id, entry);
      scheduleHistoryRender();
      revealNotificationGeneration();
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
    case 'processing':
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
  scheduleHistoryRender(changedIds);
}

// ---- 初期化 ----
updateSizeSelectors(); // updatePriceEstimate() も内部で呼ばれる
window.addEventListener('load', subscribe);
initPushNotifications();

