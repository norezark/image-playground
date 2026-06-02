// image-input.js – 入力画像の管理（ドロップゾーン・ファイル選択）

import { el } from './utils.js';

const inputDropZone   = document.getElementById('inputDropZone');
const inputFileInput  = document.getElementById('inputFileInput');
const inputThumbnails = document.getElementById('inputThumbnails');

// 各要素: { dataUrl, mimeType, name }
export const inputImages = [];

export function clearInputImages() {
  inputImages.length = 0;
}

export function addInputImage(img) {
  inputImages.push(img);
}

export function renderInputThumbnails() {
  inputThumbnails.innerHTML = '';
  inputImages.forEach((img, idx) => {
    const btn = el('button', { class: 'remove-thumb', type: 'button', text: '×',
      onclick: () => { inputImages.splice(idx, 1); renderInputThumbnails(); } });
    inputThumbnails.appendChild(
      el('div', { class: 'input-thumb' }, [
        el('img', { src: img.dataUrl, title: img.name }),
        btn,
      ])
    );
  });
}

export function addFiles(files) {
  const slots = 16 - inputImages.length;
  const toAdd = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, slots);
  let loaded  = 0;
  for (const file of toAdd) {
    const reader = new FileReader();
    reader.onload = (e) => {
      inputImages.push({ dataUrl: e.target.result, mimeType: file.type, name: file.name });
      if (++loaded === toAdd.length) renderInputThumbnails();
    };
    reader.readAsDataURL(file);
  }
}

// プロンプト入力欄への画像ペーストを入力画像として受け取る
const promptTextarea = document.getElementById('prompt');
promptTextarea.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageFiles = items
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(Boolean);
  if (imageFiles.length === 0) return;
  e.preventDefault();
  addFiles(imageFiles);
});

inputDropZone.addEventListener('click', (e) => {
  if (e.target !== inputFileInput && !e.target.closest('label[for="inputFileInput"]')) inputFileInput.click();
});
inputFileInput.addEventListener('change', () => { addFiles(inputFileInput.files); inputFileInput.value = ''; });
inputDropZone.addEventListener('dragover',  (e) => { e.preventDefault(); inputDropZone.classList.add('drag-over'); });
inputDropZone.addEventListener('dragleave', ()  => inputDropZone.classList.remove('drag-over'));
inputDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  inputDropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});
