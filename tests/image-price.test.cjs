'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const priceModule = import('../public/image-price.js');

// OpenAI公式計算器 (2026-09-09) の出力値。
// GptImageTokenCalculator.react.yz8GdjDh.js と照合。品質順: low, medium, high, xhigh, max。
const examples = [
  [1024, 1024, [196, 439, 1756, 3122, 7024]],
  [1536, 1024, [158, 343, 1372, 2459, 5488]],
  [2048, 2048, [397, 892, 3568, 6343, 14272]],
  [2880, 2880, [659, 1483, 5930, 10542, 23719]],
  [2048, 896, [108, 231, 967, 1719, 3866]], // .5 を偶数に切り下げるケース
  [1536, 864, [120, 280, 1078, 1917, 4312]], // .5 を偶数に切り上げるケース
  [3840, 2160, [371, 865, 3336, 5930, 13342]],
];

test('all five qualities match official output-token examples in both orientations', async () => {
  const { estimateImage25Tokens } = await priceModule;
  for (const [width, height, expected] of examples) {
    for (const [i, quality] of ['low', 'medium', 'high', 'xhigh', 'max'].entries()) {
      assert.equal(estimateImage25Tokens(width, height, quality), expected[i]);
      assert.equal(estimateImage25Tokens(height, width, quality), expected[i]);
    }
  }
});

test('CometAPI standard output rate is applied without rounding the unit price early', async () => {
  const { estimateImage25Price } = await priceModule;
  const result = estimateImage25Price('1024x1024', 'medium');
  assert.equal(result.minPerImage, 0.010536);
  assert.equal(result.maxPerImage, 0.010536);
  assert.deepEqual(result.assumptions, []);
});

test('default and auto quality show low-to-max range instead of assuming medium', async () => {
  const { estimateImage25Price } = await priceModule;
  for (const quality of ['', 'auto', undefined]) {
    const result = estimateImage25Price('1024x1024', quality);
    assert.equal(result.minPerImage, 0.004704);
    assert.equal(result.maxPerImage, 0.168576);
    assert.deepEqual(result.assumptions, ['品質Auto: Low〜Maxの範囲']);
  }
});

test('auto size explicitly identifies its reference size', async () => {
  const { estimateImage25Price } = await priceModule;
  const result = estimateImage25Price('auto', 'high');
  assert.equal(result.minPerImage, 0.042144);
  assert.deepEqual(result.assumptions, ['サイズAuto: 1024×1024を仮定']);
  assert.equal(estimateImage25Price('auto', '').assumptions.length, 2);
});

test('invalid dimensions or quality do not produce a misleading price', async () => {
  const { estimateImage25Price, estimateImage25Tokens } = await priceModule;
  for (const size of ['bad', '1024x1024x16', '0x1024', '1025x1024', '512x512', '3840x3840', '4096x1024', '3072x768']) {
    assert.equal(estimateImage25Price(size, 'low'), null, size);
  }
  assert.equal(estimateImage25Price('1024x1024', 'ultra'), null);
  assert.equal(estimateImage25Tokens(NaN, 1024, 'low'), null);
  assert.equal(estimateImage25Tokens(Infinity, 1024, 'low'), null);
  assert.equal(estimateImage25Tokens(1024.5, 1024, 'low'), null);
});
