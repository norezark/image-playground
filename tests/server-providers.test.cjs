'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createTestServer } = require('./helpers/test-server.cjs');

async function initialState(url) {
  const response = await fetch(url + '/events', { signal: AbortSignal.timeout(5000) });
  const reader = response.body.getReader();
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE closed before init');
      text += new TextDecoder().decode(value);
      const match = text.match(/event: init\ndata: ([^\n]+)\n\n/);
      if (match) return JSON.parse(match[1]);
    }
  } finally { await reader.cancel(); }
}

function generate(url, params, inputImages) {
  return fetch(url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Provider switching test', params, inputImages }), signal: AbortSignal.timeout(5000) });
}

test('HTTP generation and edits retain each provider through SSE, history and SQLite', async t => {
  const app = await createTestServer();
  t.after(app.close);
  assert.deepEqual((await initialState(app.url)).providers, { cometapi: true, openai: true, gemini: true });
  assert.equal((await generate(app.url, { model: 'gpt-image-2' })).status, 202);
  assert.equal((await generate(app.url, { model: 'gpt-image-2', provider: 'openai' })).status, 202);
  assert.equal((await generate(app.url, { model: 'gpt-image-2', provider: 'openai' }, [
    { dataUrl: 'data:image/png;base64,aW1hZ2U=' },
  ])).status, 202);
  let history;
  for (let attempt = 0; attempt < 50; attempt++) {
    ({ history } = await (await fetch(app.url + '/history')).json());
    if (history.length === 3) break;
    await delay(20);
  }
  assert.equal(history.length, 3);
  assert.ok(history.every(entry => entry.status === 'completed'));
  assert.deepEqual(history.map(entry => entry.params.provider).sort(), ['cometapi', 'openai', 'openai']);
  assert.deepEqual(app.requests().map(request => request.url), [
    'https://api.cometapi.com/v1/images/generations',
    'https://api.openai.com/v1/images/generations',
    'https://api.openai.com/v1/images/edits',
  ]);
  const state = await initialState(app.url);
  assert.equal(state.history.length, 3);
  assert.equal(state.pending.length, 0);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(app.root, 'history.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT params FROM entries').all().map(row => JSON.parse(row.params).provider).sort(),
      ['cometapi', 'openai', 'openai']);
  } finally { db.close(); }
});

test('official-only setup starts, reports booleans, and rejects invalid requests before saving inputs', async t => {
  const app = await createTestServer({ cometapi: false, gemini: false });
  t.after(app.close);
  const state = await initialState(app.url);
  assert.deepEqual(state.providers, { cometapi: false, openai: true, gemini: false });
  assert.equal(JSON.stringify(state).includes('test-official'), false);
  for (const params of [
    { model: 'gpt-image-2' },
    { model: 'gpt-image-2-all', provider: 'openai' },
    { model: 'gemini-2.5-flash-image', provider: 'openai' },
  ]) {
    const response = await generate(app.url, params, [{ dataUrl: 'data:image/png;base64,aW1hZ2U=' }]);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.deepEqual(app.requests(), []);
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'public/images/inputs')), []);
  assert.deepEqual((await initialState(app.url)).history, []);
});
