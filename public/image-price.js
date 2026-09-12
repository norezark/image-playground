// GPT Image 2.5 (Flare / Sunburst) の画像出力分の概算。2026-09-09 確認。
// 計算式: https://developers.openai.com/api/docs/guides/image-generation#gpt-image-25-and-gpt-image-2-output-tokens
// 公式計算器: GptImageTokenCalculator.react.yz8GdjDh.js
// 単価: https://www.cometapi.com/models/openai/gpt-image-2-5-flare/
// 標準割引: https://www.cometapi.com/pricing/ （公式単価 × 0.8）
const QUALITY_GRID = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };
const OUTPUT_USD_PER_MILLION = 30 * 0.8;

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

export function estimateImage25Price(size, quality) {
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
  const tokens = qualities.map(value => estimateImage25Tokens(width, height, value));
  if (tokens.some(value => value === null)) return null;
  if (automaticQuality) assumptions.push('品質Auto: Low〜Maxの範囲');
  return {
    minPerImage: Math.min(...tokens) * OUTPUT_USD_PER_MILLION / 1000000,
    maxPerImage: Math.max(...tokens) * OUTPUT_USD_PER_MILLION / 1000000,
    assumptions,
  };
}
