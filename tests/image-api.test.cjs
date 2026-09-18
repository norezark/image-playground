'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { callGenerations, callEdits, getProviderAvailability, validateGenerationParams } = require('../lib/api');

beforeEach(t => {
  const keys = { OPENAI_API_KEY: 'test-legacy-comet', COMET_API_KEY: '',
    OPENAI_OFFICIAL_API_KEY: 'test-official', NANO_BANANA_API_KEY: 'test-gemini' };
  for (const [name, value] of Object.entries(keys)) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
});

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

test('official models use the official host, dedicated key and generation parameter names', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return { ok: true, json: async () => ({ data: [] }) };
  });
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']) {
    await callGenerations('A circle', { provider: 'openai', model, format: 'jpeg', input_fidelity: 'high', style: 'vivid' });
    assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
    assert.equal(request.headers.Authorization, 'Bearer test-official');
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, model);
    assert.equal(payload.output_format, 'jpeg');
    for (const field of ['format', 'provider', 'input_fidelity', 'style']) assert.equal(field in payload, false);
  }
});

test('edits select endpoint and credentials per request without mixing providers', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ data: [] }) };
  });
  process.env.COMET_API_KEY = 'test-dedicated-comet';
  const signal = new AbortController().signal;
  const files = [{ filename: 'input.png', mimeType: 'image/png', buffer: Buffer.from('input') }];
  await Promise.all(['openai', 'cometapi'].map(provider => callEdits('An edit', {
    provider, model: 'gpt-image-2.5-flare', format: 'webp', input_fidelity: 'high',
  }, files, signal)));
  for (const [index, host, key] of [[0, 'api.openai.com', 'test-official'], [1, 'api.cometapi.com', 'test-dedicated-comet']]) {
    const request = requests[index];
    assert.equal(request.url, `https://${host}/v1/images/edits`);
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    assert.equal(request.signal, signal);
    assert.equal(request.body.get('model'), 'gpt-image-2.5-flare');
    assert.equal(request.body.get('output_format'), 'webp');
    assert.equal(request.body.get('input_fidelity'), 'high');
    assert.equal(request.body.has('provider'), false);
    assert.equal(await request.body.get('image[]').text(), 'input');
  }
});

test('legacy requests keep CometAPI routing and dedicated CometAPI key takes precedence', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return { ok: true, json: async () => ({ data: [] }) };
  });
  await callGenerations('A circle', { model: 'gpt-image-2' });
  assert.equal(request.url, 'https://api.cometapi.com/v1/images/generations');
  assert.equal(request.headers.Authorization, 'Bearer test-legacy-comet');
  process.env.COMET_API_KEY = 'test-dedicated-comet';
  await callGenerations('A circle', { model: 'gpt-image-2' });
  assert.equal(request.headers.Authorization, 'Bearer test-dedicated-comet');
});

test('missing official key fails before any network request and never falls back to CometAPI', async t => {
  delete process.env.OPENAI_OFFICIAL_API_KEY;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  await assert.rejects(callGenerations('A circle', { provider: 'openai', model: 'gpt-image-2' }), /OPENAI_OFFICIAL_API_KEY/);
  await assert.rejects(callEdits('An edit', { provider: 'openai', model: 'gpt-image-2' }, []), /OPENAI_OFFICIAL_API_KEY/);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(getProviderAvailability(), { cometapi: true, openai: false, gemini: true });
});

test('unsupported provider/model pairs and official legacy sizes fail before queuing', () => {
  for (const params of [
    { provider: 'openai', model: 'gpt-image-2-all' },
    { provider: 'openai', model: 'gemini-2.5-flash-image' },
    { provider: 'gemini', model: 'gpt-image-2' },
    { provider: 'unknown', model: 'gpt-image-2' },
    { provider: ['openai'], model: 'gpt-image-2' },
    { provider: 'openai', model: 'gpt-image-1.5', size: '2048x2048' },
  ]) assert.throws(() => validateGenerationParams(params));
  assert.equal(validateGenerationParams({ model: 'gpt-image-2' }).provider, 'cometapi');
  assert.equal(validateGenerationParams({ model: 'gemini-2.5-flash-image' }).provider, 'gemini');
});
