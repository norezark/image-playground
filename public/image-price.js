// GPT Image 2.5 / 2.6 (Flare / Sunburst) の画像出力分の概算。
// 計算式: https://developers.openai.com/api/docs/guides/image-generation#gpt-image-25-and-gpt-image-2-output-tokens
// 公式計算器: GptImageTokenCalculator.react.yz8GdjDh.js
// 単価: https://www.cometapi.com/models/openai/gpt-image-2-5-flare/
// 標準割引: https://www.cometapi.com/pricing/ （公式単価 × 0.8）
const QUALITY_GRID = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };
const OFFICIAL_OUTPUT_USD_PER_MILLION = 30;
// 2026-11-06: 公式 GptImageTokenCalculator.react.D6e1YylC.js と照合。
// 2.6は2.5のトークン数を切り上げた後、Lowを4.2倍、Mediumを3.3倍し整数に丸める。
const IMAGE_26_MULTIPLIER = { low: 4.2, medium: 3.3, high: 1, xhigh: 1, max: 1 };

export function estimateImage25Tokens(width, height, quality) {
  const gridLong = QUALITY_GRID[quality];
  const pixels = width * height;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (!gridLong || !Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0 || width % 16 || height % 16
      || longEdge > 3840 || longEdge / shortEdge > 3
      || pixels < 655360 || pixels > 8294400) return null;

  const scaledShort = gridLong / (longEdge / shortEdge);
  const floor = Math.floor(scaledShort);
  // 公式計算器は .5 を最も近い偶数に丸める（Math.round とは異なる）。
  const gridShort = scaledShort - floor === 0.5 ? floor + floor % 2 : Math.round(scaledShort);
  return Math.ceil(gridLong * gridShort * (2000000 + pixels) / 4000000);
}

export function estimateImage26Tokens(width, height, quality) {
  const tokens = estimateImage25Tokens(width, height, quality);
  return tokens === null ? null : Math.round(tokens * IMAGE_26_MULTIPLIER[quality]);
}

export function estimateImagePrice(size, quality, provider = 'cometapi', version = '2.5') {
  const outputRate = OFFICIAL_OUTPUT_USD_PER_MILLION * (provider === 'openai' ? 1 : 0.8);
  const assumptions = [];
  if (!size || size === 'auto') {
    size = '1024x1024';
    assumptions.push('サイズAuto: 1024×1024を仮定');
  }
  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  if (!dimensions) return null;
  const [width, height] = dimensions.slice(1).map(Number);
  const automaticQuality = !quality || quality === 'auto';
  const qualities = automaticQuality ? Object.keys(QUALITY_GRID) : [quality];
  const estimateTokens = version === '2.6' ? estimateImage26Tokens : estimateImage25Tokens;
  const tokens = qualities.map(value => estimateTokens(width, height, value));
  if (tokens.some(value => value === null)) return null;
  if (automaticQuality) assumptions.push('品質Auto: Low〜Maxの範囲');
  return {
    minPerImage: Math.min(...tokens) * outputRate / 1000000,
    maxPerImage: Math.max(...tokens) * outputRate / 1000000,
    assumptions,
  };
}

export const estimateImage25Price = (size, quality, provider) => estimateImagePrice(size, quality, provider, '2.5');
export const estimateImage26Price = (size, quality, provider) => estimateImagePrice(size, quality, provider, '2.6');
