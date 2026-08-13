// params-popup.js – 生成パラメータ一覧のポップアップ表示

import { el } from './utils.js';

const popup   = document.getElementById('paramsPopup');
const promptEl = document.getElementById('paramsPopupPrompt');
const listEl   = document.getElementById('paramsPopupList');
const closeBtn = document.getElementById('paramsPopupClose');
const copyBtn  = document.getElementById('paramsPopupCopyPrompt');
const loadBtn  = document.getElementById('paramsPopupLoadPrompt');

let _loadPromptOnly = null;
let _currentEntry   = null;

// script.js から「プロンプトのみロード」コールバックを受け取る
export function initParamsPopup(loadPromptOnly) {
  _loadPromptOnly = loadPromptOnly;
}

function renderParamsList(entry) {
  listEl.innerHTML = '';
  const rows = Object.entries(entry.params || {})
    .filter(([, v]) => v !== '' && v != null);

  for (const [key, value] of rows) {
    listEl.appendChild(el('div', { class: 'params-popup-row' }, [
      el('span', { class: 'params-popup-key', text: key }),
      el('span', { class: 'params-popup-value', text: String(value) }),
    ]));
  }
}

export function openParamsPopup(entry) {
  _currentEntry = entry;
  promptEl.textContent = entry.prompt || '';
  renderParamsList(entry);
  popup.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeParamsPopup() {
  popup.classList.remove('is-open');
  document.body.style.overflow = '';
  _currentEntry = null;
}

closeBtn.addEventListener('click', closeParamsPopup);
popup.addEventListener('click', (e) => {
  if (e.target === popup) closeParamsPopup();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popup.classList.contains('is-open')) closeParamsPopup();
});

copyBtn.addEventListener('click', async () => {
  if (!_currentEntry) return;
  const original = copyBtn.textContent;
  try {
    await navigator.clipboard.writeText(_currentEntry.prompt || '');
    copyBtn.textContent = 'コピーしました';
  } catch (err) {
    console.error('クリップボードへのコピー失敗', err);
    copyBtn.textContent = 'コピー失敗';
  }
  setTimeout(() => { copyBtn.textContent = original; }, 1500);
});

loadBtn.addEventListener('click', () => {
  if (!_currentEntry || !_loadPromptOnly) return;
  _loadPromptOnly(_currentEntry);
  closeParamsPopup();
});
