import { el } from './utils.js';

function measureColumnWidth(width) {
  // computedStyleの小数表示をそのまま引き算すると、1レイアウト単位未満の
  // 丸め誤差が残る。ブラウザが実際に採用する幅に揃えてから利用する。
  const probe = el('div', { style: `position:absolute;visibility:hidden;box-sizing:border-box;padding:0;border:0;width:${width}px` });
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().width;
  probe.remove();
  return measured;
}

export function stabilizeHistoryColumns(root, {
  Observer = globalThis.ResizeObserver,
  readColumns = () => getComputedStyle(root).gridTemplateColumns,
  measureWidth = measureColumnWidth,
} = {}) {
  let previousColumns;
  let previousWidth;
  function update() {
    const columns = readColumns();
    if (columns === previousColumns) return;
    const widths = columns.trim().split(/\s+/).map(value => value.endsWith('px') ? parseFloat(value) : NaN);
    if (!widths.length || widths.some(width => !Number.isFinite(width) || width <= 5)) return;
    const width = measureWidth(Math.min(...widths));
    if (!Number.isFinite(width) || width <= 5) return;
    previousColumns = columns;
    if (width === previousWidth) return;
    previousWidth = width;
    root.style.setProperty('--history-column-width', `${width}px`);
  }
  // 履歴カードを作る前に幅を決めて、初期画像の読み込みも安定させる。
  update();
  const observer = Observer ? new Observer(update) : null;
  const view = root.ownerDocument.defaultView;
  if (observer) observer.observe(root);
  else view.addEventListener('resize', update);
  return () => {
    observer?.disconnect();
    if (!observer) view.removeEventListener('resize', update);
  };
}
