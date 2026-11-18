const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadMonitor(globals) {
  const element = { addEventListener() {} };
  const context = vm.createContext({
    document: { querySelector: () => element, getElementById: () => element },
    ResizeObserver: class { observe() {} },
    location: { href: 'http://127.0.0.1:54323/' }, AbortSignal, URL, URLSearchParams, ...globals,
  });
  vm.runInContext(readFileSync(join(__dirname, '..', 'viewer.js'), 'utf8'), context);
  return vm.runInContext('monitorStream(signal, onSlowRenderer)', context);
}

test('live input without a new drawing triggers recovery, while an idle desktop does not', () => {
  let now = 0;
  const controller = new AbortController();
  const monitor = loadMonitor({
    signal: controller.signal, performance: { now: () => now },
    fetch: () => new Promise(() => {}), onSlowRenderer() {},
  });
  monitor.presented(0, 0, 0);
  for (let i = 0; i < 10; i++) {
    now += 6000;
    assert.equal(monitor.received(), false);
  }
  monitor.presented(0, 0, 0);
  for (let i = 0; i < 75; i++) {
    now += 20;
    assert.equal(monitor.received(), false);
  }
  now += 20;
  assert.equal(monitor.received(), true);
  monitor.presented(0, 0, 0);
  now += 20;
  assert.equal(monitor.received(), false);
  controller.abort();
});

test('sustained slow drawing triggers recovery even when some frames still appear', async () => {
  let now = 0;
  let nextPing;
  let recoveries = 0;
  const controller = new AbortController();
  const monitor = loadMonitor({
    signal: controller.signal,
    performance: { now: () => now, getEntriesByName: () => [], clearResourceTimings() {} },
    fetch: async () => ({ status: 204, headers: { get: () => String(now * 1000) }, arrayBuffer: async () => new ArrayBuffer(0) }),
    setTimeout(callback) { nextPing = callback; },
    onSlowRenderer() { recoveries++; },
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick();
  async function sample(drawEvery) {
    for (let i = 0; i < 50; i++) {
      now += 20;
      assert.equal(monitor.received(), false);
      if (i % drawEvery === 0) monitor.presented(now, 0, 0);
    }
    nextPing();
    await tick();
  }
  await sample(10);
  await sample(1);
  await sample(10);
  await sample(10);
  assert.equal(recoveries, 0);
  await sample(10);
  assert.equal(recoveries, 1);
  controller.abort();
});
