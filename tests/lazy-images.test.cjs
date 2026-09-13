'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loaderModule = import('../public/lazy-images.js');
const settle = () => new Promise(resolve => setImmediate(resolve));

class FakeImage extends EventTarget {
  constructor(id) {
    super();
    this.dataset = { src: `/images/${id}.png` };
    this.isConnected = true;
    this.requests = [];
    this.classes = new Set(['is-lazy']);
    this.classList = { contains: name => this.classes.has(name), remove: name => this.classes.delete(name) };
  }
  set src(value) {
    this.source = value;
    if (!value.startsWith('data:')) this.requests.push(value);
  }
  get src() { return this.source; }
  decode() { return Promise.resolve(); }
  loaded() { this.dispatchEvent(new Event('load')); }
  failed() { this.dispatchEvent(new Event('error')); }
}

async function setup(t, options = {}) {
  const { createLazyImageLoader } = await loaderModule;
  let observer;
  const frames = [];
  const images = Array.from({ length: 6 }, (_, id) => new FakeImage(id));
  const loader = createLazyImageLoader({
    Observer: class {
      constructor(callback, settings) { observer = { callback, settings }; }
      observe() {}
      unobserve() {}
    },
    schedule: callback => frames.push(callback),
    ...options,
  });
  images.forEach(img => loader.observe(img));
  t.after(async () => {
    for (const img of images) { img.isConnected = false; loader.release(img); }
    await settle();
  });
  return {
    images, loader,
    intersect(visible, ...ids) {
      observer.callback(ids.map(id => ({ target: images[id], isIntersecting: visible })));
    },
    frame() { frames.splice(0).forEach(callback => callback()); },
  };
}

test('only nearby images load, with at most two slots including decode time', async t => {
  const { images, intersect, frame } = await setup(t);
  let finishDecode;
  images[0].decode = () => new Promise(resolve => { finishDecode = resolve; });
  intersect(true, 0, 1, 2, 3);
  frame();
  assert.deepEqual(images.map(img => img.requests.length), [1, 1, 0, 0, 0, 0]);
  images[0].loaded();
  await settle();
  frame();
  assert.equal(images[2].requests.length, 0, 'decode still occupies a slot');
  images[1].loaded();
  await settle();
  frame();
  assert.deepEqual(images.map(img => img.requests.length), [1, 1, 1, 0, 0, 0]);
  finishDecode();
  await settle();
  frame();
  assert.equal(images[3].requests.length, 1);
  images[2].loaded();
  images[3].loaded();
  await settle();
  intersect(true, 0); // A delayed observer callback must not reload an existing image.
  frame();
  assert.equal(images[0].requests.length, 1);
  assert.equal(images[4].requests.length, 0, 'far-away images never start');
});

test('fast scrolling drops queued images outside the preload area and allows returning', async t => {
  const { images, intersect, frame } = await setup(t);
  intersect(true, 0, 1, 2, 3);
  frame();
  intersect(false, 2, 3);
  intersect(true, 4);
  images[0].loaded();
  await settle();
  frame();
  assert.equal(images[2].requests.length, 0);
  assert.equal(images[3].requests.length, 0);
  assert.equal(images[4].requests.length, 1);
  intersect(true, 2);
  images[1].loaded();
  await settle();
  frame();
  assert.equal(images[2].requests.length, 1);
});

test('removed tiles cancel active work, release queued work, and errors do not stall the queue', async t => {
  const { images, loader, intersect, frame } = await setup(t);
  intersect(true, 0, 1, 2, 3, 4);
  frame();
  for (const id of [0, 2]) {
    images[id].isConnected = false;
    loader.release(images[id]);
  }
  await settle();
  frame();
  assert.ok(images[0].src.startsWith('data:'), 'cancel the actual image request');
  assert.equal(images[2].requests.length, 0);
  assert.equal(images[3].requests.length, 1);
  images[1].failed();
  await settle();
  frame();
  assert.equal(images[4].requests.length, 1);
});

test('a stalled request times out and releases slots for later images', async t => {
  const { images, intersect, frame } = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  intersect(true, 0, 1, 2);
  frame();
  t.mock.timers.tick(30000);
  await settle();
  frame();
  assert.ok(images[0].src.startsWith('data:'));
  assert.ok(images[1].src.startsWith('data:'));
  assert.equal(images[2].requests.length, 1);
});

test('browsers without IntersectionObserver still limit simultaneous loading', async t => {
  const { images, frame } = await setup(t, { Observer: null });
  frame();
  assert.deepEqual(images.map(img => img.requests.length), [1, 1, 0, 0, 0, 0]);
  images[0].loaded();
  await settle();
  frame();
  assert.equal(images[2].requests.length, 1);
});
