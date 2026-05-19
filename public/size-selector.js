// size-selector.js – サイズ計算とビジュアルセレクタ

import { updatePriceEstimate } from './price-estimate.js';

export const SIZE_TIERS = { S: 1024, M: 1536, L: 2048, XL: 2880 };
const ASPECT_RATIOS_MAP = {
  '4:3':  [4, 3],
  '3:2':  [3, 2],
  '16:9': [16, 9],
  '2:1':  [2, 1],
  '3:1':  [3, 1],
};

export function computeResolution(orientation, ratio, tier) {
  if (orientation === 'auto') return 'auto';
  const baseLong = SIZE_TIERS[tier] || 1024;
  if (orientation === 'square') {
    const maxSquare = Math.floor(Math.sqrt(8294400) / 16) * 16;
    const edge      = Math.min(Math.round(baseLong / 16) * 16, maxSquare);
    return `${edge}x${edge}`;
  }
  const [lp, sp] = ASPECT_RATIOS_MAP[ratio] || [4, 3];
  const calcShort = (l) => Math.round(l * sp / lp / 16) * 16;
  let longEdge  = Math.round(baseLong / 16) * 16;
  let shortEdge = calcShort(longEdge);
  while (longEdge * shortEdge < 655360) {
    longEdge += 16;
    shortEdge = calcShort(longEdge);
    if (longEdge > 3840 || shortEdge > 3840) return null;
  }
  while (longEdge * shortEdge > 8294400 || longEdge > 3840 || shortEdge > 3840) {
    longEdge -= 16;
    if (longEdge < 16) return null;
    shortEdge = calcShort(longEdge);
  }
  if (longEdge < shortEdge || longEdge / shortEdge > 3.001 || longEdge * shortEdge < 655360) return null;
  return orientation === 'landscape' ? `${longEdge}x${shortEdge}` : `${shortEdge}x${longEdge}`;
}

export function sizeToSelects(sizeStr) {
  if (!sizeStr || sizeStr === 'auto') return { orientation: 'auto', ratio: '4:3', tier: 'S' };
  const [ws, hs] = sizeStr.split('x');
  const w = parseInt(ws, 10), h = parseInt(hs, 10);
  if (!w || !h) return { orientation: 'auto', ratio: '4:3', tier: 'S' };
  let orientation, longEdge, shortEdge;
  if (w === h)    { orientation = 'square';    longEdge = w; shortEdge = h; }
  else if (w > h) { orientation = 'landscape'; longEdge = w; shortEdge = h; }
  else            { orientation = 'portrait';  longEdge = h; shortEdge = w; }
  let bestRatio = '4:3', bestDiff = Infinity;
  if (orientation !== 'square') {
    for (const [key, [lp, sp]] of Object.entries(ASPECT_RATIOS_MAP)) {
      const diff = Math.abs(longEdge / shortEdge - lp / sp);
      if (diff < bestDiff) { bestDiff = diff; bestRatio = key; }
    }
  }
  let bestTier = 'S', bestTierDiff = Infinity;
  for (const [key, val] of Object.entries(SIZE_TIERS)) {
    const diff = Math.abs(longEdge - val);
    if (diff < bestTierDiff) { bestTierDiff = diff; bestTier = key; }
  }
  return { orientation, ratio: bestRatio, tier: bestTier };
}

export function setVisualGroup(groupId, inputId, value) {
  document.getElementById(inputId).value = value;
  document.querySelectorAll(`#${groupId} .vis-btn`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

export function updateSizeSelectors() {
  const orientation = document.getElementById('sizeOrientation').value;
  const isAuto      = orientation === 'auto';
  const isSquare    = orientation === 'square';
  const isPortrait  = orientation === 'portrait';
  document.getElementById('sizeRatioLabel').style.display = (isAuto || isSquare) ? 'none' : '';
  document.getElementById('sizeTierLabel').style.display  = isAuto ? 'none' : '';

  document.querySelectorAll('#sizeRatioGroup .vis-shape[data-lw]').forEach(shape => {
    const { lw, lh } = shape.dataset;
    shape.style.width  = isPortrait ? `${lh}px` : `${lw}px`;
    shape.style.height = isPortrait ? `${lw}px` : `${lh}px`;
  });

  const res = isAuto ? null : computeResolution(
    orientation,
    document.getElementById('sizeRatio').value,
    document.getElementById('sizeTier').value,
  );
  document.getElementById('sizePreview').textContent = res && res !== 'auto' ? `= ${res.replace('x', ' × ')}` : '';
  updatePriceEstimate();
}

document.getElementById('sizeOrientationGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.vis-btn');
  if (!btn) return;
  setVisualGroup('sizeOrientationGroup', 'sizeOrientation', btn.dataset.value);
  updateSizeSelectors();
});
document.getElementById('sizeRatioGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.vis-btn');
  if (!btn) return;
  setVisualGroup('sizeRatioGroup', 'sizeRatio', btn.dataset.value);
  updateSizeSelectors();
});
document.getElementById('sizeTier').addEventListener('change', updateSizeSelectors);
