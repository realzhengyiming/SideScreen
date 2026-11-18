const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('a slow decoder finishes its first frame before resynchronizing on a keyframe', () => {
  const decoders = [];
  const draws = [];
  const messages = [];
  let now = 0;
  class Decoder {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.chunks = [];
      this.decodeQueueSize = 0;
      decoders.push(this);
    }
    configure() { this.state = 'configured'; }
    close() { this.state = 'closed'; }
    decode(chunk) { this.chunks.push(chunk); }
    output(timestamp) {
      let closed = false;
      this.callbacks.output({ timestamp, close() { closed = true; } });
      assert.ok(closed);
    }
  }
  const self = { postMessage: (message) => messages.push(message) };
  const context = vm.createContext({
    self, VideoDecoder: Decoder, performance: { now: () => now, timeOrigin: 0 },
    EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
  });
  vm.runInContext(readFileSync(join(__dirname, '..', 'decoder-worker.js'), 'utf8'), context);
  const send = (data) => self.onmessage({ data });
  const decode = (timestamp, keyframe) => send({ type: 'decode', data: new Uint8Array(1), timestamp, encodedAt: timestamp, keyframe });
  send({ type: 'init', canvas: { getContext: () => ({ drawImage: (frame) => draws.push(frame.timestamp) }) } });
  send({ type: 'configure', config: { codec: 'hev1.1.6.L153.B0' } });
  for (let i = 0; i < 12; i++) decode(i, i === 0);
  decode(12, false);
  decode(13, true);
  assert.equal(decoders.length, 1);
  assert.equal(decoders[0].chunks.length, 12);
  assert.equal(decoders[0].state, 'configured');
  assert.equal(messages.filter((m) => m.type === 'needKeyframe').length, 0);

  now = 180;
  decoders[0].output(0);
  assert.deepEqual(draws, [0]);
  decode(14, false);
  assert.equal(decoders[0].chunks.length, 12);
  assert.equal(messages.filter((m) => m.type === 'needKeyframe').length, 1);
  decode(15, true);
  assert.equal(decoders.length, 1);
  assert.equal(decoders[0].chunks.at(-1).timestamp, 15);
  assert.equal(decoders[0].chunks.at(-1).type, 'key');
  decoders[0].output(15);

  send({ type: 'configure', config: { codec: 'avc1.4d0033' } });
  assert.equal(decoders.length, 2);
  assert.equal(decoders[0].state, 'closed');
  decoders[0].output(1);
  decode(16, true);
  decoders[1].output(decoders[1].chunks[0].timestamp);
  assert.deepEqual(messages.filter((m) => m.type === 'frame').map((m) => m.encodedAt), [0, 15, 16]);
});
