let canvas;
let context;
let decoder;
let generation = 0;
const frames = new Map();

function resetDecoder() {
  generation += 1;
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = undefined;
  frames.clear();
}

function configure(config) {
  resetDecoder();
  const activeGeneration = generation;
  decoder = new VideoDecoder({
    output(frame) {
      try {
        if (generation !== activeGeneration) return;
        const metadata = frames.get(frame.timestamp);
        frames.delete(frame.timestamp);
        if (!metadata) return;
        const decodedAt = performance.now();
        if (decodedAt - metadata.started > 100) return;
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        const renderedAt = performance.now();
        self.postMessage({
          type: 'frame',
          encodedAt: metadata.encodedAt,
          decodeMs: decodedAt - metadata.started,
          renderMs: renderedAt - decodedAt,
          renderedAt: performance.timeOrigin + renderedAt,
        });
      } finally {
        frame.close();
      }
    },
    error(error) { self.postMessage({ type: 'error', message: error.message }); },
  });
  decoder.configure(config);
}

self.onmessage = ({ data }) => {
  try {
    switch (data.type) {
      case 'init':
        canvas = data.canvas;
        context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context) throw new Error('独立线程无法创建画布');
        break;
      case 'resize':
        resetDecoder();
        canvas.width = data.width;
        canvas.height = data.height;
        break;
      case 'configure':
        configure(data.config);
        break;
      case 'decode':
        if (!decoder || decoder.state !== 'configured') break;
        if (decoder.decodeQueueSize >= 3 || frames.size >= 6) {
          resetDecoder();
          self.postMessage({ type: 'reset' });
          break;
        }
        frames.set(data.timestamp, { started: performance.now(), encodedAt: data.encodedAt });
        decoder.decode(new EncodedVideoChunk({
          type: data.keyframe ? 'key' : 'delta', timestamp: data.timestamp, data: data.data,
        }));
        break;
      case 'reset':
        resetDecoder();
        break;
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};

self.postMessage({ type: 'ready', supported: !!self.VideoDecoder && !!self.OffscreenCanvas });
