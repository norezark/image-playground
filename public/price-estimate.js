// price-estimate.js – 料金見積もり

import { computeResolution } from './size-selector.js';

const OFFICIAL_PRICE_TABLE = {
  'gpt-image-2': {
    low:    { square: 0.006,  nonSquare: 0.005 },
    medium: { square: 0.053,  nonSquare: 0.041 },
    high:   { square: 0.211,  nonSquare: 0.165 },
  },
  'gpt-image-1.5': {
    low:    { square: 0.009,  nonSquare: 0.013 },
    medium: { square: 0.034,  nonSquare: 0.050 },
    high:   { square: 0.133,  nonSquare: 0.200 },
  },
  'gpt-image-1': {
    low:    { square: 0.011,  nonSquare: 0.016 },
    medium: { square: 0.042,  nonSquare: 0.063 },
    high:   { square: 0.167,  nonSquare: 0.250 },
  },
  'gpt-image-1-mini': {
    low:    { square: 0.005,  nonSquare: 0.006 },
    medium: { square: 0.011,  nonSquare: 0.015 },
    high:   { square: 0.036,  nonSquare: 0.052 },
  },
};
const COMETAPI_DISCOUNT        = 0.8;
const PRICE_BASE_PIXELS_SQUARE = 1024 * 1024;
const PRICE_BASE_PIXELS_NON_SQ = 1024 * 1536;

function computeEstimatedPrice() {
  const model       = document.getElementById('model').value;
  const quality     = document.getElementById('quality').value || 'medium';
  const n           = Math.max(1, parseInt(document.getElementById('n').value, 10) || 1);
  const orientation = document.getElementById('sizeOrientation').value;
  const ratio       = document.getElementById('sizeRatio').value;
  const tier        = document.getElementById('sizeTier').value;

  if (model === 'gpt-image-2-all') return { perImage: 0.04, n, isApprox: false };

  const modelPrices = OFFICIAL_PRICE_TABLE[model];
  if (!modelPrices) return null;

  const qualityKey = ['low', 'medium', 'high'].includes(quality) ? quality : 'medium';
  const qualityRow = modelPrices[qualityKey];
  const isSquare   = orientation === 'square' || orientation === 'auto';
  const basePrice  = COMETAPI_DISCOUNT * (isSquare ? qualityRow.square : qualityRow.nonSquare);
  const basePixels = isSquare ? PRICE_BASE_PIXELS_SQUARE : PRICE_BASE_PIXELS_NON_SQ;

  let scale = 1;
  if (orientation !== 'auto') {
    const res = computeResolution(orientation, ratio, tier);
    if (res && res !== 'auto') {
      const [w, h] = res.split('x').map(Number);
      scale = (w * h) / basePixels;
    }
  }
  return { perImage: basePrice * scale, n, isApprox: true };
}

function fmtUSD(usd) {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01)  return `$${usd.toFixed(4)}`;
  if (usd < 1)     return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function updatePriceEstimate() {
  const result  = computeEstimatedPrice();
  const priceEl = document.getElementById('priceEstimate');
  if (!result) { priceEl.textContent = ''; return; }
  const prefix = result.isApprox ? '〜' : '';
  let text = `${prefix}${fmtUSD(result.perImage)} / 枚`;
  if (result.n > 1) text += ` × ${result.n} = ${prefix}${fmtUSD(result.perImage * result.n)}`;
  priceEl.textContent = `推定料金 (CometAPI): ${text}`;
}

document.getElementById('model').addEventListener('change', updatePriceEstimate);
document.getElementById('quality').addEventListener('change', updatePriceEstimate);
document.getElementById('n').addEventListener('input', updatePriceEstimate);
