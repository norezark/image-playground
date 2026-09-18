'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const models = import('../public/model-selection.js');

test('model selections and history distinguish the same model on different providers', async () => {
  const { parseModelSelection, modelSelectionValue, displayParams } = await models;
  for (const [value, expected] of [
    ['gpt-image-2', { model: 'gpt-image-2', provider: 'cometapi' }],
    ['openai:gpt-image-2', { model: 'gpt-image-2', provider: 'openai' }],
    ['gemini-2.5-flash-image', { model: 'gemini-2.5-flash-image', provider: 'gemini' }],
  ]) {
    assert.deepEqual(parseModelSelection(value), expected);
    assert.equal(modelSelectionValue(expected), value);
  }
  assert.equal(modelSelectionValue({ model: 'gpt-image-2-all' }), 'gpt-image-2-all');
  assert.equal(displayParams({ model: 'gpt-image-2' }).provider, 'CometAPI');
  assert.equal(displayParams({ model: 'gpt-image-2', provider: 'openai' }).provider, 'OpenAI公式');
});

test('only official legacy models are limited to standard image dimensions', async () => {
  const { usesStandardImageSizes } = await models;
  for (const model of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini']) {
    assert.equal(usesStandardImageSizes({ provider: 'openai', model }), true);
    assert.equal(usesStandardImageSizes({ provider: 'cometapi', model }), false);
  }
  assert.equal(usesStandardImageSizes({ provider: 'openai', model: 'gpt-image-2' }), false);
  assert.equal(usesStandardImageSizes({ provider: 'openai', model: 'gpt-image-2.5-flare' }), false);
});
