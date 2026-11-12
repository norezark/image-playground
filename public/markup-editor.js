import { el } from './utils.js';

export async function openMarkupEditor(image) {
  const source = el('img', { src: image.dataUrl, alt: '描き込み対象の画像', draggable: 'false' });
  await source.decode();
  if (source.naturalWidth * source.naturalHeight > 16777216) throw new Error('描き込み対象は16,777,216画素以下の画像にしてください。');
  const canvas = el('canvas', { width: source.naturalWidth, height: source.naturalHeight, 'aria-label': '丸や線で編集箇所を描き込む' });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let dirty = !!image.markupDataUrl;
  if (image.markupDataUrl) {
    const overlay = el('img', { src: image.markupDataUrl });
    await overlay.decode();
    ctx.drawImage(overlay, 0, 0);
  }
  const tool = el('select', { 'aria-label': '描画ツール' }, [el('option', { value: 'pen', text: 'ペン' }), el('option', { value: 'circle', text: '丸' })]);
  const color = el('input', { type: 'color', value: '#ff3030', 'aria-label': '線の色' });
  const width = el('input', { type: 'range', min: 2, max: 32, value: 6, 'aria-label': '線の太さ' });
  const undo = el('button', { type: 'button', text: '元に戻す', disabled: '' });
  const clear = el('button', { type: 'button', text: '描き込みを消去' });
  const cancel = el('button', { type: 'button', text: 'キャンセル' });
  const save = el('button', { type: 'button', class: 'markup-save', text: '描き込みを使う' });
  const stage = el('div', { class: 'markup-stage' }, [source, canvas]);
  const dialog = el('dialog', { class: 'markup-dialog', 'aria-label': '編集箇所の描き込み' }, [
    el('h3', { text: '先頭の画像に編集指示を描き込む' }),
    el('p', { text: '丸や線で場所を示し、プロンプトで変更内容を指示してください。元の画像は保持されます。' }),
    el('div', { class: 'markup-tools' }, [tool, color, width, undo, clear]),
    stage,
    el('div', { class: 'markup-actions' }, [cancel, save]),
  ]);
  const snapshots = [];
  const maxSnapshots = Math.max(1, Math.min(8, Math.floor(64 * 1024 * 1024 / (canvas.width * canvas.height * 4))));
  let stroke;
  function remember() {
    snapshots.push({ pixels: ctx.getImageData(0, 0, canvas.width, canvas.height), dirty });
    if (snapshots.length > maxSnapshots) snapshots.shift();
    undo.disabled = false;
  }
  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  }
  canvas.addEventListener('pointerdown', event => {
    if (stroke || event.button !== 0) return;
    event.preventDefault();
    remember();
    const start = position(event);
    stroke = { start, pointer: event.pointerId, tool: tool.value, moved: false };
    canvas.setPointerCapture(event.pointerId);
    ctx.strokeStyle = color.value;
    ctx.lineWidth = Number(width.value) * canvas.width / canvas.getBoundingClientRect().width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
  });
  canvas.addEventListener('pointermove', event => {
    if (!stroke || event.pointerId !== stroke.pointer) return;
    const point = position(event);
    stroke.moved = true;
    if (stroke.tool === 'circle') {
      ctx.putImageData(snapshots.at(-1).pixels, 0, 0);
      ctx.beginPath();
      ctx.ellipse((point.x + stroke.start.x) / 2, (point.y + stroke.start.y) / 2,
        Math.abs(point.x - stroke.start.x) / 2, Math.abs(point.y - stroke.start.y) / 2, 0, 0, Math.PI * 2);
    } else ctx.lineTo(point.x, point.y);
    ctx.stroke();
    dirty = true;
  });
  function endStroke(event) {
    if (!stroke || event.pointerId !== stroke.pointer) return;
    if (!stroke.moved && stroke.tool === 'pen') {
      ctx.lineTo(stroke.start.x + 0.01, stroke.start.y);
      ctx.stroke();
      dirty = true;
    }
    stroke = null;
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  undo.addEventListener('click', () => {
    const snapshot = snapshots.pop();
    if (snapshot) { ctx.putImageData(snapshot.pixels, 0, 0); dirty = snapshot.dirty; }
    undo.disabled = !snapshots.length;
  });
  clear.addEventListener('click', () => { remember(); ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; });
  document.body.appendChild(dialog);
  return new Promise(resolve => {
    let result;
    cancel.addEventListener('click', () => dialog.close());
    save.addEventListener('click', () => { result = { dataUrl: dirty ? canvas.toDataURL('image/png') : null }; dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
  });
}
