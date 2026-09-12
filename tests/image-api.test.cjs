'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { callGenerations, callEdits } = require('../lib/api');

for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  test(`${model}: generations sends new quality and output format`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, json: async () => ({ data: [{ b64_json: 'image' }] }) };
    });
    const signal = new AbortController().signal;
    for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
      for (const format of ['png', 'jpeg', 'webp']) {
        const result = await callGenerations('A blue circle', {
          model, quality, format, n: '2', size: '1536x1024',
          input_fidelity: 'high', output_compression: format === 'png' ? '' : '0',
        }, signal);
        const request = requests.at(-1);
        const payload = JSON.parse(request.body);
        assert.equal(request.url, 'https://api.cometapi.com/v1/images/generations');
        assert.equal(request.signal, signal);
        assert.equal(payload.model, model);
        assert.equal(payload.quality, quality);
        assert.equal(payload.output_format, format);
        assert.equal(payload.n, 2);
        assert.equal(payload.size, '1536x1024');
        assert.equal('format' in payload, false);
        assert.equal('input_fidelity' in payload, false);
        assert.equal(payload.output_compression, format === 'png' ? undefined : 0);
        assert.equal(result.data.length, 1);
      }
    }
  });

  test(`${model}: edits preserves images and quality in multipart`, async (t) => {
    let request;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      request = { url, ...options };
      return { ok: true, json: async () => ({ data: [{ b64_json: 'image' }] }) };
    });
    const files = ['one.png', 'two.png'].map(filename => ({
      filename, mimeType: 'image/png', buffer: Buffer.from('test image'),
    }));
    for (const quality of ['xhigh', 'max']) {
      await callEdits('Make the circle red', {
        model, quality, format: 'webp', n: '1', size: '1024x1024', input_fidelity: 'high',
      }, files, new AbortController().signal);
      assert.equal(request.url, 'https://api.cometapi.com/v1/images/edits');
      assert.equal(request.body.get('model'), model);
      assert.equal(request.body.get('quality'), quality);
      assert.equal(request.body.get('output_format'), 'webp');
      assert.equal(request.body.get('input_fidelity'), 'high');
      assert.deepEqual(request.body.getAll('image[]').map(file => file.name), ['one.png', 'two.png']);
      assert.equal(await request.body.get('image[]').text(), 'test image');
    }
  });
}

test('existing CometAPI models retain their generation format parameter', async (t) => {
  let payload;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [] }) };
  });
  for (const model of ['gpt-image-2-all', 'gpt-image-2', 'gpt-image-1.5']) {
    await callGenerations('A circle', { model, quality: 'high', format: 'jpeg' });
    assert.equal(payload.model, model);
    assert.equal(payload.format, 'jpeg');
    assert.equal('output_format' in payload, false);
  }
});
