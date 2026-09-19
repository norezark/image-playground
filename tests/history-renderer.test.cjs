'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rendererModule = import('../public/history-renderer.js');

class Node {
  constructor(key) { this.key = key; this.parentNode = null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
}

class Container {
  children = [];
  mutations = [];
  get firstChild() { return this.children[0] || null; }
  insertBefore(node, anchor) {
    assert.ok(anchor === null || anchor.parentNode === this, 'anchor belongs to the list');
    assert.notEqual(node, anchor);
    this.mutations.push({ type: node.parentNode ? 'move' : 'insert', node });
    if (node.parentNode) node.parentNode.removeChild(node);
    this.children.splice(anchor === null ? this.children.length : this.children.indexOf(anchor), 0, node);
    node.parentNode = this;
  }
  removeChild(node) {
    assert.equal(node.parentNode, this);
    this.mutations.push({ type: 'remove', node });
    this.children.splice(this.children.indexOf(node), 1);
    node.parentNode = null;
  }
}

function entry(id, seconds, images = [`/${id}.png`]) {
  return { id, timestamp: new Date(seconds * 1000).toISOString(), images, status: images.length ? 'completed' : 'queued' };
}

async function setup() {
  const { createHistoryRenderer } = await rendererModule;
  const container = new Container();
  const released = [];
  const inspected = [];
  const renderer = createHistoryRenderer({
    container,
    tileSignature: (entry, url) => { inspected.push(entry.id); return JSON.stringify([entry, url]); },
    renderTile: (entry, url) => new Node(`${entry.id}:${url}`),
    releaseTile: node => released.push(node),
  });
  return { container, released, inspected, ...renderer };
}

test('1708 existing cards are neither scanned nor moved during a generation lifecycle', async () => {
  const app = await setup();
  const entries = new Map(Array.from({ length: 1708 }, (_, i) => [String(i), entry(String(i), 2000 - i)]));
  app.render(entries);
  const original = [...app.container.children];
  app.container.mutations.length = app.inspected.length = 0;
  entries.values = () => { assert.fail('incremental updates must not enumerate history'); };

  entries.set('new', entry('new', 3000, []));
  app.render(entries, new Set(['new']));
  assert.deepEqual(app.container.mutations.map(m => m.type), ['insert']);
  assert.deepEqual(app.inspected, ['new']);
  assert.deepEqual(app.container.children.slice(1), original);

  for (const status of ['preprocessing', 'generating', 'retrying']) {
    app.container.mutations.length = app.inspected.length = 0;
    entries.get('new').status = status;
    app.render(entries, new Set(['new']));
    assert.deepEqual(app.container.mutations.map(m => m.type), ['remove', 'insert']);
    assert.deepEqual(app.inspected, ['new']);
    assert.deepEqual(app.container.children.slice(1), original);
  }

  app.container.mutations.length = 0;
  entries.set('new', { ...entries.get('new'), status: 'completed', images: ['/result-a.png', '/result-b.png'] });
  app.render(entries, new Set(['new']));
  assert.deepEqual(app.container.children.slice(2), original);
  assert.deepEqual(app.container.mutations.map(m => m.type), ['remove', 'insert', 'insert']);
  assert.deepEqual(app.getVisibleImages().slice(0, 2), ['/result-a.png', '/result-b.png']);

  app.container.mutations.length = 0;
  entries.delete('new');
  app.render(entries, new Set(['new']));
  assert.deepEqual(app.container.children, original);
  assert.deepEqual(app.container.mutations.map(m => m.type), ['remove', 'remove']);
  assert.ok(app.released.every(node => node.key.startsWith('new:')));
});

test('unchanged snapshots reuse nodes and full resync removes old nodes before ordering the survivors', async () => {
  const app = await setup();
  const entries = new Map(['a', 'b', 'c'].map((id, i) => [id, entry(id, 10 - i)]));
  app.render(entries);
  const original = [...app.container.children];
  app.container.mutations.length = 0;
  entries.set('b', { ...entries.get('b') });
  app.render(entries, new Set(['b', 'missing']));
  app.render(entries);
  assert.equal(app.container.mutations.length, 0);
  assert.deepEqual(app.container.children, original);

  entries.delete('a');
  app.render(entries);
  assert.deepEqual(app.container.children, original.slice(1));
  assert.deepEqual(app.container.mutations.map(m => m.type), ['remove']);
  assert.deepEqual(app.released, [original[0]]);
});

test('out-of-order arrivals, timestamp changes and equal timestamps retain chronological and stable order', async () => {
  const app = await setup();
  const entries = new Map();
  for (const [id, time] of [['a', 10], ['b', 30], ['c', 20], ['d', 20]]) {
    entries.set(id, entry(id, time));
    app.render(entries, new Set([id]));
  }
  assert.deepEqual(app.getVisibleImages(), ['/b.png', '/c.png', '/d.png', '/a.png']);
  const bNode = app.container.firstChild;
  entries.get('a').timestamp = entry('a', 25).timestamp;
  app.render(entries, new Set(['a']));
  assert.deepEqual(app.getVisibleImages(), ['/b.png', '/a.png', '/c.png', '/d.png']);
  assert.equal(app.container.firstChild, bNode);
  entries.get('a').timestamp = entry('a', 5).timestamp;
  app.render(entries, new Set(['a']));
  assert.deepEqual(app.getVisibleImages(), ['/b.png', '/c.png', '/d.png', '/a.png']);
});

test('favorites updates affect only that entry, including hidden cards and timestamp ties', async () => {
  const app = await setup();
  const entries = new Map([
    ['a', entry('a', 10, ['/a1.png', '/a2.png'])],
    ['b', { ...entry('b', 10), favoritedImages: ['/b.png'] }],
    ['pending', entry('pending', 20, [])],
  ]);
  app.render(entries, undefined, true);
  const bNode = app.container.firstChild;
  entries.get('a').favoritedImages = ['/a2.png'];
  app.render(entries, new Set(['a']), true);
  assert.deepEqual(app.getVisibleImages(), ['/a2.png', '/b.png']);
  assert.equal(app.container.children[1], bNode);
  app.container.mutations.length = 0;
  entries.get('pending').status = 'preprocessing';
  app.render(entries, new Set(['pending']), true);
  assert.equal(app.container.mutations.length, 0);
  entries.get('a').favoritedImages = [];
  app.render(entries, new Set(['a']), true);
  assert.deepEqual(app.container.children, [bNode]);
  app.render(entries);
  assert.deepEqual(app.getVisibleImages(), ['/a1.png', '/a2.png', '/b.png']);
  assert.equal(app.container.children.at(-1), bNode);
});

test('batched additions, cancellation and image list changes leave unrelated cards in place', async () => {
  const app = await setup();
  const entries = new Map([['old', entry('old', 10)]]);
  app.render(entries);
  const oldNode = app.container.firstChild;
  entries.set('a', entry('a', 20, []));
  entries.set('b', entry('b', 30, []));
  app.render(entries, new Set(['a', 'b']));
  entries.set('a', entry('a', 20, ['/a1.png', '/a2.png']));
  entries.delete('b');
  app.render(entries, new Set(['b', 'a']));
  const a2Node = app.container.children[1];
  app.container.mutations.length = 0;
  entries.set('a', entry('a', 20, ['/a2.png']));
  app.render(entries, new Set(['a']));
  assert.equal(app.container.children.at(-1), oldNode);
  assert.deepEqual(app.getVisibleImages(), ['/a2.png', '/old.png']);
  assert.ok(app.container.mutations.every(m => m.node !== oldNode));
  assert.ok(app.released.includes(a2Node), 'changed tile content is released before replacement');
});

test('consecutive SSE updates render only the latest state once per frame', async () => {
  const { createHistoryRenderScheduler } = await rendererModule;
  const app = await setup();
  const entries = new Map([['old', entry('old', 10)]]);
  app.render(entries);
  app.container.mutations.length = 0;
  const frames = [];
  const schedule = createHistoryRenderScheduler(ids => app.render(entries, ids), callback => frames.push(callback));
  entries.set('new', entry('new', 20, []));
  schedule(new Set(['new']));
  entries.get('new').status = 'preprocessing';
  schedule(new Set(['new']));
  entries.get('new').status = 'generating';
  schedule(new Set(['new']));
  assert.equal(frames.length, 1);
  assert.equal(app.container.mutations.length, 0);
  frames.shift()();
  assert.deepEqual(app.container.mutations.map(m => m.type), ['insert']);
  assert.deepEqual(app.inspected, ['old', 'new']);
});

test('full synchronization or filter changes supersede queued partial renders', async () => {
  const { createHistoryRenderScheduler } = await rendererModule;
  const frames = [];
  const renders = [];
  const schedule = createHistoryRenderScheduler(ids => renders.push(ids), callback => frames.push(callback));
  schedule(new Set(['a']));
  schedule();
  schedule(new Set(['b']));
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(renders, [undefined]);
  schedule(new Set(['c']));
  schedule(new Set(['d']));
  frames.shift()();
  assert.deepEqual(renders, [undefined, new Set(['c', 'd'])]);
});
