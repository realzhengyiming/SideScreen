let canvas;
let context;
let decoder;
let generation = 0;
let waitingForKeyframe = false;
let recoveryRequested = false;
const frames = new Map();

function queueFull() {
  return decoder.decodeQueueSize >= 6 || frames.size >= 12;
}

function requestRecoveryFrame() {
  if (waitingForKeyframe && !recoveryRequested && !queueFull()) {
    recoveryRequested = true;
    self.postMessage({ type: 'needKeyframe' });
  }
}

function resetDecoder() {
  generation += 1;
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = undefined;
  waitingForKeyframe = false;
  recoveryRequested = false;
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
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        const renderedAt = performance.now();
        self.postMessage({
          type: 'frame',
          encodedAt: metadata.encodedAt,
          decodeMs: decodedAt - metadata.started,
          renderMs: renderedAt - decodedAt,
          renderedAt: performance.timeOrigin + renderedAt,
        });
        requestRecoveryFrame();
      } finally {
        frame.close();
      }
    },
    error(error) {
      if (generation === activeGeneration) self.postMessage({ type: 'error', message: error.message });
    },
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
        if (queueFull()) {
          waitingForKeyframe = true;
          if (data.keyframe) recoveryRequested = false;
          break;
        }
        // A keyframe restores the prediction chain. Keep the configured decoder and let
        // its in-flight frames finish, including a slow first output.
        if (waitingForKeyframe && !data.keyframe) {
          requestRecoveryFrame();
          break;
        }
        waitingForKeyframe = false;
        recoveryRequested = false;
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
