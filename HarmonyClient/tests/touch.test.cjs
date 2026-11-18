const assert = require('node:assert/strict');
const test = require('node:test');

function unpack(bytes) {
  const wire = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes[offset++], 2);
    const count = bytes[offset++];
    const points = [];
    for (let i = 0; i < count; i++) {
      points.push([wire.getFloat32(offset, true), wire.getFloat32(offset + 4, true)]);
      offset += 8;
    }
    events.push({ action: wire.getInt32(offset, true), points });
    offset += 4;
  }
  return events;
}

async function viewer(t, flipX = 1) {
  const { bindTabletTouch } = await import('../touch.mjs');
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 60, top: 120, width: 200, height: 100 });
  canvas.setPointerCapture = () => {};
  const controller = new AbortController();
  const events = [];
  const replies = [];
  const oldWindow = global.window;
  global.window = new EventTarget();
  t.mock.method(global, 'fetch', (_url, options) => {
    assert.equal(options.headers['X-SideScreen-Stream'], 'viewer-token');
    events.push(...unpack(options.body));
    return new Promise((resolve) => replies.push(resolve));
  });
  t.after(() => { controller.abort(); global.window = oldWindow; });
  bindTabletTouch(canvas, 'viewer-token', controller.signal, () => ({ flipX, flipY: 1 }), () => controller.abort());
  function pointer(type, id, x, y, pointerType = 'touch') {
    const event = Object.assign(new Event(type, { cancelable: true }),
      { pointerType, pointerId: id, clientX: x, clientY: y });
    canvas.dispatchEvent(event);
  }
  async function reply(ok = true) {
    replies.shift()({ ok });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { events, replies, pointer, reply, controller };
}

test('touch uses the visible canvas, respects flips and preserves down, last move and up under backpressure', async (t) => {
  const v = await viewer(t, -1);
  v.pointer('pointerdown', 1, 110, 145, 'mouse');
  assert.equal(v.events.length, 0);
  v.pointer('pointerdown', 1, 110, 145);
  v.pointer('pointermove', 1, 135, 170);
  v.pointer('pointermove', 1, 160, 195);
  v.pointer('pointerup', 1, 300, 235);
  assert.equal(v.replies.length, 1);
  await v.reply();
  assert.deepEqual(v.events, [
    { action: 0, points: [[.75, .25]] },
    { action: 1, points: [[.5, .75]] },
    { action: 2, points: [[0, 1]] },
  ]);
});

test('lifting two fingers and losing capture do not make an extra click', async (t) => {
  const v = await viewer(t);
  v.pointer('pointerdown', 3, 60, 120);
  v.pointer('pointerdown', 4, 110, 195);
  v.pointer('pointermove', 4, 160, 195);
  v.pointer('pointerup', 4, 160, 195);
  v.pointer('pointerup', 3, 60, 120);
  v.pointer('pointerdown', 5, 110, 145);
  v.pointer('pointercancel', 5, 110, 145);
  v.pointer('lostpointercapture', 5, 110, 145);
  await v.reply();
  assert.deepEqual(v.events.map(({ action, points }) => [action, points.length]),
    [[0, 1], [0, 2], [1, 2], [2, 2], [0, 1], [3, 1]]);
  await v.reply(false);
  assert.ok(v.controller.signal.aborted);
  v.pointer('pointerdown', 6, 60, 120);
  assert.equal(v.replies.length, 0);
});
