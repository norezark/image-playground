// image-input.js – 入力画像の管理（ドロップゾーン・ファイル選択）

import { el } from './utils.js';
import { openMarkupEditor } from './markup-editor.js';
import { getImageModelCapabilities, parseModelSelection } from './model-selection.js';

const inputDropZone   = document.getElementById('inputDropZone');
const inputFileInput  = document.getElementById('inputFileInput');
const inputThumbnails = document.getElementById('inputThumbnails');

// 各要素: { dataUrl, mimeType, name }
export const inputImages = [];
let inputRevision = 0;
let fileQueue = Promise.resolve();
export const getInputRevision = () => inputRevision;

export function clearInputImages() {
  inputRevision++;
  inputImages.length = 0;
}

export function addInputImage(img) {
  inputImages.push(img);
}

export function renderInputThumbnails() {
  inputThumbnails.innerHTML = '';
  const caps = getImageModelCapabilities(parseModelSelection(document.getElementById('model').value).model);
  inputImages.forEach((img, idx) => {
    const btn = el('button', { class: 'remove-thumb', type: 'button', text: '×',
      onclick: () => { inputImages.splice(idx, 1); renderInputThumbnails(); } });
    inputThumbnails.appendChild(
      el('div', { class: 'input-thumb' }, [
        el('img', { src: img.dataUrl, title: img.name }),
        ...(img.markupDataUrl ? [el('img', { src: img.markupDataUrl, class: 'input-markup-overlay', alt: '描き込み' })] : []),
        btn,
        ...(idx === 0 && caps.markup ? [el('button', { type: 'button', class: 'markup-button', text: '描き込み', title: img.markupDataUrl ? '保存済みの描き込みを編集' : '丸や線で編集箇所を指定', onclick: async () => {
          try {
            const result = await openMarkupEditor(img);
            if (result) { img.markupDataUrl = result.dataUrl; renderInputThumbnails(); }
          } catch (error) { alert(error.message); }
        } })] : []),
      ])
    );
  });
  window.dispatchEvent(new Event('input-images-changed'));
}

export function addFiles(files) {
  const snapshot = Array.from(files).filter(file => file.type.startsWith('image/'));
  const revision = inputRevision;
  fileQueue = fileQueue.then(async () => {
    if (revision !== inputRevision) return;
    const toAdd = snapshot.slice(0, 16 - inputImages.length);
    const images = await Promise.all(toAdd.map(file => blobToInputImage(file, file.name)));
    if (revision === inputRevision) { inputImages.push(...images); renderInputThumbnails(); }
  }).catch(error => alert('入力画像を読み込めませんでした: ' + error.message));
  return fileQueue;
}

export async function blobToInputImage(blob, name) {
  if (blob.type === 'image/svg+xml' || blob.type === 'image/gif') {
    let source;
    let objectUrl;
    try {
      try { source = await createImageBitmap(blob); }
      catch {
        objectUrl = URL.createObjectURL(blob);
        source = el('img', { src: objectUrl });
        await source.decode();
      }
      const width = source.naturalWidth || source.width;
      const height = source.naturalHeight || source.height;
      if (!width || !height || width * height > 16777216) throw new Error('静止画への変換は16,777,216画素以下で利用してください。');
      const canvas = el('canvas', { width, height });
      canvas.getContext('2d').drawImage(source, 0, 0);
      return { dataUrl: canvas.toDataURL('image/png'), mimeType: 'image/png', name: name.replace(/\.(gif|svg)$/i, '') + '.png' };
    } finally { source?.close?.(); if (objectUrl) URL.revokeObjectURL(objectUrl); }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('画像ファイルを読み込めません。'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mimeType: blob.type, name };
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
