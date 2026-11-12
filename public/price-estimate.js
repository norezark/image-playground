// price-estimate.js – 料金見積もり

import { computeResolution } from './size-selector.js';
import { estimateImagePrice } from './image-price.js';
import { parseModelSelection, PROVIDER_LABELS, getImageModelCapabilities } from './model-selection.js';

const GEMINI_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);

// 出典: https://ai.google.dev/gemini-api/docs/pricing (2026-05-19 更新)
// preview モデルは安定版になる前に変更される可能性あり
const GEMINI_PRICE_TABLE = {
  // $30/1M トークン。1K(1024×1024)=1290トークン → $0.039/枚（固定）
  'gemini-2.5-flash-image': { perImage: 0.039 },
  // $60/1M トークン。サイズ別料金
  'gemini-3.1-flash-image-preview': {
    perImageBySize: { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
  },
  // $120/1M トークン。サイズ別料金
  'gemini-3-pro-image-preview': {
    perImageBySize: { '1K': 0.134, '2K': 0.134, '4K': 0.240 },
  },
};

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
  const selection = { ...parseModelSelection(document.getElementById('model').value), format: document.getElementById('format').value };
  const { model } = selection;
  const provider = PROVIDER_LABELS[selection.provider];
  const discount = selection.provider === 'openai' ? 1 : COMETAPI_DISCOUNT;
  const quality     = document.getElementById('quality').value;
  const n           = Math.max(1, parseInt(document.getElementById('n').value, 10) || 1);
  const orientation = document.getElementById('sizeOrientation').value;
  const ratio       = document.getElementById('sizeRatio').value;
  const tier        = document.getElementById('sizeTier').value;

  if (GEMINI_MODELS.has(model)) {
    const entry = GEMINI_PRICE_TABLE[model];
    if (!entry) return null;
    if (entry.perImage != null) {
      // 固定料金 (gemini-2.5-flash-image)
      return { perImage: entry.perImage, n, provider: 'Gemini API', isApprox: false };
    }
    if (entry.perImageBySize) {
      // サイズ別料金
      const imageSize = document.getElementById('gemini_image_size')?.value || '1K';
      const perImage  = entry.perImageBySize[imageSize] ?? null;
      if (perImage == null) return { perImage: null, n, provider: 'Gemini API', unknown: true };
      return { perImage, n, provider: 'Gemini API', isApprox: false };
    }
    return { perImage: null, n, provider: 'Gemini API', unknown: true };
  }

  if (model === 'gpt-image-2-all') return { perImage: 0.04, n, provider, isApprox: false };

  const caps = getImageModelCapabilities(model);
  if (caps.extendedQuality) {
    if (selection.format === 'gif') return { n, provider, unknown: true,
      reason: 'GIFの事前見積もりは未対応（フレーム・入力に応じて課金）' };
    const size = computeResolution(orientation, ratio, tier, selection);
    const estimate = size && estimateImagePrice(size, quality, selection.provider, caps.image26 ? '2.6' : '2.5');
    if (!estimate) return { n, provider, unknown: true,
      reason: '選択したサイズ・品質では見積もりできません' };
    return { ...estimate, n, provider, imageOutput: true, svg: selection.format === 'svg', outputRate: 30 * discount };
  }

  const modelPrices = OFFICIAL_PRICE_TABLE[model];
  if (!modelPrices) return null;

  const qualityKey = ['low', 'medium', 'high'].includes(quality) ? quality : 'medium';
  const qualityRow = modelPrices[qualityKey];
  const isSquare   = orientation === 'square' || orientation === 'auto';
  const basePrice  = discount * (isSquare ? qualityRow.square : qualityRow.nonSquare);
  const basePixels = isSquare ? PRICE_BASE_PIXELS_SQUARE : PRICE_BASE_PIXELS_NON_SQ;

  let scale = 1;
  if (orientation !== 'auto') {
    const res = computeResolution(orientation, ratio, tier, selection);
    if (res && res !== 'auto') {
      const [w, h] = res.split('x').map(Number);
      scale = (w * h) / basePixels;
    }
  }
  return { perImage: basePrice * scale, n, provider, isApprox: true };
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
  priceEl.title = '';
  if (!result) { priceEl.textContent = ''; return; }
  if (result.unknown) {
    priceEl.textContent = `推定料金 (${result.provider}): ${result.reason || 'preview モデルのため料金未確認'}`;
    return;
  }
  if (result.imageOutput) {
    const amount = (count) => {
      const low = `$${(result.minPerImage * count).toFixed(5)}`;
      const high = `$${(result.maxPerImage * count).toFixed(5)}`;
      return low === high ? low : `${low}〜${high}`;
    };
    let text = `推定料金 (${result.provider}): 約${amount(1)} / 枚`;
    if (result.n > 1) text += ` × ${result.n} = 約${amount(result.n)}`;
    text += '（出力分・入力料金別）';
    if (result.svg) text += ' ＋SVG作成モデルの料金';
    if (result.assumptions.length) text += ` ${result.assumptions.join(' / ')}`;
    priceEl.textContent = text;
    priceEl.title = `OpenAI公式計算器の出力トークン数 × $${result.outputRate} / 100万トークン${result.outputRate === 24 ? '（CometAPI標準20%割引）' : '（OpenAI公式）'}。入力テキスト・入力画像・リトライの料金は別途かかります。実請求額は契約・使用量により異なります。`;
    return;
  }
  const provider = result.provider || 'CometAPI';
  const prefix = result.isApprox ? '〜' : '';
  let text = `${prefix}${fmtUSD(result.perImage)} / 枚`;
  if (result.n > 1) text += ` × ${result.n} = ${prefix}${fmtUSD(result.perImage * result.n)}`;
  priceEl.textContent = `推定料金 (${provider}): ${text}`;
}

document.getElementById('model').addEventListener('change', updatePriceEstimate);
document.getElementById('quality').addEventListener('change', updatePriceEstimate);
document.getElementById('n').addEventListener('input', updatePriceEstimate);
document.getElementById('gemini_image_size').addEventListener('change', updatePriceEstimate);
document.getElementById('format').addEventListener('change', updatePriceEstimate);
