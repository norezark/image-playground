'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const columnsModule = import('../public/history-columns.js');

async function setup({ initial = '233.797px 233.797px 233.797px 233.797px 233.812px', fallback = false } = {}) {
  const { stabilizeHistoryColumns } = await columnsModule;
  const writes = [];
  const measurements = [];
  const view = new EventTarget();
  const root = { style: { setProperty: (...args) => writes.push(args) }, ownerDocument: { defaultView: view } };
  let columns = initial;
  let callback;
  let disconnected = false;
  const stop = stabilizeHistoryColumns(root, {
    Observer: fallback ? null : class {
      constructor(update) { callback = update; }
      observe(target) { assert.equal(target, root); }
      disconnect() { disconnected = true; }
    },
    readColumns: () => columns,
    measureWidth: width => { measurements.push(width); return Math.round(width * 64) / 64; },
  });
  return {
    writes, measurements, stop,
    resize(value = columns) {
      columns = value;
      if (fallback) view.dispatchEvent(new Event('resize'));
      else callback();
    },
    get disconnected() { return disconnected; },
  };
}

test('fractional column widths share a measured inner width; new rows do not measure or restyle all cards', async () => {
  const app = await setup();
  assert.deepEqual(app.writes, [['--history-column-width', '233.796875px']]);
  assert.deepEqual(app.measurements, [233.797]);
  for (let i = 0; i < 100; i++) app.resize(); // Height notifications while history grows.
  assert.equal(app.writes.length, 1);
  assert.equal(app.measurements.length, 1);
  app.stop();
  assert.equal(app.disconnected, true);
});

test('viewport and column-count changes refresh the width, while hidden or unresolved grids retain the previous value', async () => {
  const app = await setup();
  app.resize('171.5px 171.5px');
  app.resize('none');
  app.resize('0px 0px');
  assert.equal(app.writes.length, 2);
  assert.deepEqual(app.writes.at(-1), ['--history-column-width', '171.5px']);
  app.resize('184.797px 184.812px');
  assert.deepEqual(app.writes.at(-1), ['--history-column-width', '184.796875px']);
  app.resize('184.797px 184.797px 184.812px');
  assert.equal(app.writes.length, 3, 'unchanged measured widths do not invalidate descendant styles');
});

test('an initially hidden grid initializes on becoming visible; old browsers update on window resize', async () => {
  const app = await setup({ initial: 'none', fallback: true });
  assert.equal(app.writes.length, 0);
  app.resize('180px 180px');
  assert.deepEqual(app.writes, [['--history-column-width', '180px']]);
  app.stop();
  app.resize('220px 220px');
  assert.equal(app.writes.length, 1);
});
