const DISPLAY_CONFIG = 1;
const VIDEO_FRAME = 6;
const CODEC_SELECTED = 10;
const H264 = 1;
const HEVC_MAIN = 'hev1.1.6.L153.B0';
const MAX_FRAME_SIZE = 32 * 1024 * 1024;

class StreamReader {
  constructor(body) {
    this.reader = body.getReader();
    this.remaining = new Uint8Array(0);
  }

  async read(size) {
    await this.readMore();
    if (this.remaining.length >= size) {
      const bytes = this.remaining.subarray(0, size);
      this.remaining = this.remaining.subarray(size);
      return bytes;
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      await this.readMore();
      const count = Math.min(size - offset, this.remaining.length);
      bytes.set(this.remaining.subarray(0, count), offset);
      this.remaining = this.remaining.subarray(count);
      offset += count;
    }
    return bytes;
  }

  async readMore() {
    while (this.remaining.length === 0) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error('USB 画面已断开，正在重连…');
      this.remaining = value;
    }
  }
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function codecFromKeyframe(bytes) {
  // SideScreen puts SPS and PPS before each IDR as Annex B NAL units.
  for (let i = 2; i + 4 < bytes.length; i++) {
    if (bytes[i - 2] === 0 && bytes[i - 1] === 0 && bytes[i] === 1 && (bytes[i + 1] & 31) === 7) {
      const profile = bytes.subarray(i + 2, i + 5);
      return 'avc1.' + Array.from(profile, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }
  throw new Error('Mac 发来的关键帧缺少 H.264 参数。');
}

const stage = document.querySelector('main');
let canvas = document.querySelector('canvas');
let workerAvailable = true;
const status = document.getElementById('status');
const fullscreen = document.getElementById('fullscreen');
const resolution = document.getElementById('resolution');
const latencyButton = document.getElementById('low-latency');
const frameDelayValue = document.getElementById('frame-delay');
const pingValue = document.getElementById('ping');
let lowLatency = false;
let playback;
let flipX = 1;
let flipY = 1;

function fitCanvas() {
  const width = Number(canvas.dataset.width) || canvas.width;
  const height = Number(canvas.dataset.height) || canvas.height;
  const scale = Math.min(
    stage.clientWidth / width,
    stage.clientHeight / height,
  );
  canvas.style.width = `${width * scale}px`;
  canvas.style.height = `${height * scale}px`;
  canvas.style.transform = `scale(${flipX}, ${flipY})`;
}

function showStatus(message) {
  status.hidden = !message;
  status.textContent = message;
  if (message) resolution.hidden = true;
}

function resetMetrics() {
  frameDelayValue.textContent = '—';
  pingValue.textContent = '—';
}

function monitorStream(signal, onSlowRenderer) {
  const recentPings = [];
  const metrics = {};
  let clockOffset;
  let delayAverage;
  let lastUpdate = -Infinity;
  let sampleAt = performance.now();
  let receivedCount = 0;
  let drawnCount = 0;
  let lastPacketAt = -Infinity;
  let lastDrawAt;
  let pendingSince;
  let pendingPackets = 0;
  let slowSamples = 0;

  async function measurePing() {
    while (!signal.aborted) {
      const start = performance.now();
      try {
        if (start > sampleAt) {
          metrics.receivedFps = Math.round(receivedCount * 1000 / (start - sampleAt));
          metrics.drawnFps = Math.round(drawnCount * 1000 / (start - sampleAt));
          const fallingBehind = lastDrawAt !== undefined && metrics.receivedFps >= 20
            && metrics.drawnFps < metrics.receivedFps / 3;
          slowSamples = fallingBehind ? slowSamples + 1 : 0;
          if (slowSamples >= 3 && onSlowRenderer) {
            onSlowRenderer();
            return;
          }
        }
        if (lastDrawAt !== undefined) metrics.lastDrawAgeMs = Math.min(60000, Math.round(start - lastDrawAt));
        sampleAt = start;
        receivedCount = drawnCount = 0;
        const query = new URLSearchParams({ ...metrics, sample: String(start) });
        const url = new URL(`/ping?${query}`, location.href);
        const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) });
        await response.arrayBuffer();
        const end = performance.now();
        signal.throwIfAborted();
        const received = parseFloat(response.headers.get('X-SideScreen-Received-Us')) / 1000;
        const sent = parseFloat(response.headers.get('X-SideScreen-Sent-Us')) / 1000;
        if (response.status !== 204 || !Number.isFinite(received) || !Number.isFinite(sent) || sent < received) {
          throw new Error('Ping unavailable');
        }

        // Estimate the clock difference from the exchange with the least queuing delay.
        metrics.fetchMs = Math.max(0, (end - start) - (sent - received));
        const timing = performance.getEntriesByName(url.href).pop();
        performance.clearResourceTimings();
        let exchangeStart = start;
        let exchangeEnd = end;
        if (timing?.responseEnd > 0 && timing.requestStart > 0) {
          exchangeStart = timing.requestStart;
          exchangeEnd = timing.responseEnd;
          metrics.scheduleMs = Math.max(0, end - timing.responseEnd);
          metrics.requestQueueMs = Math.max(0, timing.requestStart - start);
        }
        const rtt = Math.max(0, exchangeEnd - exchangeStart - (sent - received));
        metrics.httpMs = rtt;
        const offset = ((received - exchangeStart) + (sent - exchangeEnd)) / 2;
        recentPings.push({ rtt, offset });
        if (recentPings.length > 8) recentPings.shift();
        clockOffset = recentPings.reduce((best, sample) => sample.rtt <= best.rtt ? sample : best).offset;
        pingValue.textContent = `${rtt < 10 ? rtt.toFixed(1) : Math.round(rtt)} ms`;
      } catch {
        if (signal.aborted) return;
        recentPings.length = 0;
        clockOffset = undefined;
        delayAverage = undefined;
        resetMetrics();
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  function received() {
    const now = performance.now();
    receivedCount++;
    // Only count a stall while new video packets keep arriving. A static Mac desktop can be quiet.
    if (pendingSince === undefined || now - lastPacketAt > 1500) {
      pendingSince = now;
      pendingPackets = 0;
    }
    lastPacketAt = now;
    pendingPackets++;
    return pendingPackets >= 6 && now - pendingSince >= (lastDrawAt === undefined ? 7000 : 1500);
  }

  function presented(encodedAt, decodeMs, renderMs, renderedAt = performance.now(), worker = false) {
    drawnCount++;
    lastDrawAt = performance.now();
    pendingSince = undefined;
    metrics.worker = Number(worker);
    if (clockOffset === undefined) return;
    const now = renderedAt;
    const delay = Math.max(0, now + clockOffset - encodedAt);
    delayAverage = delayAverage === undefined ? delay : 0.85 * delayAverage + 0.15 * delay;
    metrics.frameMs = delayAverage;
    metrics.decodeMs = decodeMs;
    metrics.renderMs = renderMs;
    if (now - lastUpdate >= 500) {
      frameDelayValue.textContent = `≈ ${Math.round(delayAverage)} ms`;
      lastUpdate = now;
    }
  }
  measurePing();
  return { received, presented };
}

fullscreen.hidden = !stage.requestFullscreen || !document.fullscreenEnabled;
fullscreen.addEventListener('click', () => stage.requestFullscreen().catch(console.warn));
new ResizeObserver(fitCanvas).observe(stage);

class UnsupportedCodecError extends Error {}
class RetryRendererError extends Error {}
class StalledDecoderError extends Error {}

function decoderConfig(codec, width, height) {
  return { codec, codedWidth: width, codedHeight: height, optimizeForLatency: true };
}

async function createWorkerRenderer(onFrame, requestKeyframe, onError) {
  if (!workerAvailable || !canvas.transferControlToOffscreen || !globalThis.Worker) return;
  const targetCanvas = canvas;
  let worker;
  try {
    worker = new Worker('/decoder-worker.js');
  } catch {
    workerAvailable = false;
    return;
  }
  const supported = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    worker.onmessage = ({ data }) => {
      if (data.type !== 'ready') return;
      clearTimeout(timeout);
      resolve(data.supported);
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
  if (!supported || targetCanvas !== canvas) {
    worker.terminate();
    return;
  }
  let offscreen;
  try {
    offscreen = targetCanvas.transferControlToOffscreen();
  } catch {
    worker.terminate();
    return;
  }
  worker.onerror = (error) => onError(error.message || '独立渲染线程异常');
  worker.onmessage = ({ data }) => {
    if (data.type === 'frame') onFrame(data);
    if (data.type === 'needKeyframe') requestKeyframe();
    if (data.type === 'error') onError(data.message);
  };
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
  return {
    configure(config) { worker.postMessage({ type: 'configure', config }); },
    decode(bytes, timestamp, keyframe, encodedAt) {
      const data = bytes.slice().buffer;
      worker.postMessage({ type: 'decode', data, timestamp, keyframe, encodedAt }, [data]);
    },
    resize(width, height) { worker.postMessage({ type: 'resize', width, height }); },
    reset() { worker.postMessage({ type: 'reset' }); },
    close() { worker.terminate(); },
  };
}

function screenPixels() {
  const { width, height } = stage.dataset;
  if (width && height) return [Number(width), Number(height)];
  return [screen.width, screen.height].map((size) => Math.round(size * devicePixelRatio));
}

async function prefersHevc(width, height) {
  try {
    const { supported } = await VideoDecoder.isConfigSupported(decoderConfig(HEVC_MAIN, width, height));
    return supported;
  } catch {
    return false;
  }
}

async function showStream(mode, lowLatency, playbackSignal) {
  const connection = new AbortController();
  const signal = AbortSignal.any([connection.signal, playbackSignal]);
  const maxDecodeQueue = lowLatency ? 6 : 8;
  let context;
  let decoder;
  let decoderError;
  let pendingFrame;
  let drawRequest;
  let monitor;
  let avc = false;
  let width = 0;
  let height = 0;
  let firstTimestamp;
  let lastTimestamp = -1;
  let needKeyframe = true;
  let wakeLock;
  let firstFrameTimer;
  let workerRenderer;
  let workerFailed = false;
  let streamToken;
  let lastKeyframeRequest = -Infinity;
  const decodeStarted = new Map();
  let pendingDecodeMs = 0;
  let pendingDecodedAt = 0;

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = undefined;
    decodeStarted.clear();
    workerRenderer?.reset();
  }

  function requestKeyframe() {
    const now = performance.now();
    if (!streamToken || signal.aborted || now - lastKeyframeRequest < 500) return;
    lastKeyframeRequest = now;
    fetch('/keyframe', {
      method: 'POST', headers: { 'X-SideScreen-Stream': streamToken },
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    }).catch(() => {}); // Older bridges still deliver periodic keyframes.
  }

  function failWorker(message) {
    if (signal.aborted) return;
    workerAvailable = false;
    workerFailed = true;
    decoderError = new Error(message);
    connection.abort();
  }

  function stalled(message) {
    if (workerRenderer) {
      failWorker(message);
    } else {
      decoderError = new StalledDecoderError(message);
      connection.abort();
    }
  }

  function framePresented(encodedAt, decodeMs, renderMs, renderedAt, worker = false) {
    monitor.presented(encodedAt, decodeMs, renderMs, renderedAt, worker);
    if (!status.hidden) {
      clearTimeout(firstFrameTimer);
      showStatus('');
      resolution.textContent = `USB · ${width}×${height}`;
      resolution.hidden = false;
      wakeLock ??= navigator.wakeLock?.request('screen').catch(() => undefined);
    }
  }

  function present(frame, decodeMs, decodedAt) {
    try {
      if (signal.aborted) return;
      context.drawImage(frame, 0, 0, width, height);
      framePresented(Number(firstTimestamp) / 1e6 + frame.timestamp / 1000, decodeMs, performance.now() - decodedAt);
    } finally {
      frame.close();
    }
  }

  function draw(frame) {
    if (signal.aborted) {
      frame.close();
      return;
    }
    const decodedAt = performance.now();
    const started = decodeStarted.get(frame.timestamp) ?? decodedAt;
    decodeStarted.delete(frame.timestamp);
    if (needKeyframe && decoder && decoder.decodeQueueSize < maxDecodeQueue
        && decodeStarted.size < 2 * maxDecodeQueue) requestKeyframe();
    if (lowLatency) {
      present(frame, decodedAt - started, decodedAt);
      return;
    }
    pendingFrame?.close();
    pendingFrame = frame;
    pendingDecodeMs = decodedAt - started;
    pendingDecodedAt = decodedAt;
    if (drawRequest !== undefined) return;
    drawRequest = requestAnimationFrame(() => {
      const latest = pendingFrame;
      pendingFrame = undefined;
      drawRequest = undefined;
      present(latest, pendingDecodeMs, pendingDecodedAt);
    });
  }

  try {
    // A fresh canvas allows switching between main-thread and OffscreenCanvas rendering.
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
    canvas = replacement;
    if (lowLatency) {
      workerRenderer = await createWorkerRenderer(
        (frame) => {
          if (signal.aborted || !monitor) return;
          framePresented(frame.encodedAt, frame.decodeMs, frame.renderMs, frame.renderedAt - performance.timeOrigin, true);
        },
        requestKeyframe, failWorker,
      );
    }
    signal.throwIfAborted();
    if (!workerRenderer) {
      context = replacement.getContext('2d', { alpha: false, desynchronized: true });
      if (!context) throw new UnsupportedCodecError('浏览器无法创建画布。');
    }
    const [screenWidth, screenHeight] = screenPixels();
    const params = new URLSearchParams({ w: screenWidth, h: screenHeight, codec: mode.codec });
    if (mode.compat) params.set('compat', '1');
    if (lowLatency) params.set('low_latency', '1');
    const response = await fetch(`/stream?${params}`, { signal });
    if (response.status === 503) throw new Error('USB 转发还没连通，请检查数据线和「USB 调试」授权。');
    if (response.status === 502) throw new Error('正在等待 Mac 串流，请查看 Mac 上的 SideScreen 窗口。');
    if (response.status === 409) throw new Error('已有副屏页面在播放，请关闭另一标签页。');
    if (!response.ok || !response.body) throw new Error('USB 连接暂时不可用，正在重试…');
    if (response.headers.get('X-SideScreen-Transport') !== 'usb') {
      throw new Error('请重新运行 Mac 上的「打开鸿蒙副屏.command」。');
    }
    streamToken = response.headers.get('X-SideScreen-Stream');
    if (streamToken && response.headers.get('X-SideScreen-Input') === 'touch') {
      import('/touch.mjs').then(({ bindTabletTouch }) => {
        if (!signal.aborted) {
          bindTabletTouch(replacement, streamToken, signal,
            () => status.hidden ? { flipX, flipY } : undefined, () => connection.abort());
        }
      }).catch(console.warn);
    }
    const recoverSlowRenderer = lowLatency ? () => stalled('平板持续收到视频帧，画面刷新过慢') : undefined;
    monitor = monitorStream(signal, recoverSlowRenderer);
    const stream = new StreamReader(response.body);
    showStatus('已连接，等待 Mac 画面…');

    while (true) {
      const [message] = await stream.read(1);
      if (message === CODEC_SELECTED) {
        const [codec] = await stream.read(1);
        if (codec !== H264) throw new Error('请使用支持 H.264 的 SideScreen Mac 版。');
        avc = true;
        continue;
      }

      if (message === DISPLAY_CONFIG) {
        const geometry = view(await stream.read(12));
        const newWidth = geometry.getUint32(0);
        const newHeight = geometry.getUint32(4);
        const transform = geometry.getUint32(8);
        if (newWidth < 1 || newWidth > 16384 || newHeight < 1 || newHeight > 16384) {
          throw new Error('Mac 发来的画面尺寸无效。');
        }
        flipX = (Math.floor(transform / 1000) & 1) ? -1 : 1;
        flipY = (Math.floor(transform / 1000) & 2) ? -1 : 1;
        if (width !== newWidth || height !== newHeight) {
          width = newWidth;
          height = newHeight;
          canvas.dataset.width = String(width);
          canvas.dataset.height = String(height);
          if (workerRenderer) {
            workerRenderer.resize(width, height);
          } else {
            canvas.width = width;
            canvas.height = height;
          }
          showStatus('正在调整画面…');
          clearTimeout(firstFrameTimer);
          firstFrameTimer = undefined;
          closeDecoder();
          needKeyframe = true;
        }
        fitCanvas();
        continue;
      }

      if (message !== VIDEO_FRAME || (mode.codec === 'avc' && !avc) || !width) {
        throw new Error('串流协议不匹配，请使用 SideScreen Mac 1.1.1 或更新版本。');
      }
      const header = view(await stream.read(13));
      const length = header.getUint32(0);
      if (length < 1 || length > MAX_FRAME_SIZE) throw new Error('视频帧长度异常。');
      const keyframe = (header.getUint8(4) & 1) !== 0;
      const captureTime = header.getBigUint64(5);
      const bytes = await stream.read(length);

      if (monitor.received() && lowLatency) {
        stalled('持续收到视频帧，但画面停止更新');
        signal.throwIfAborted();
      }
      if (decoder && (decoder.decodeQueueSize >= maxDecodeQueue || decodeStarted.size >= 2 * maxDecodeQueue)) {
        needKeyframe = true;
        continue;
      }
      if (needKeyframe) {
        if (!keyframe) {
          requestKeyframe();
          continue;
        }
        if (!decoder) {
          const config = decoderConfig(avc ? codecFromKeyframe(bytes) : HEVC_MAIN, width, height);
          const { supported } = await VideoDecoder.isConfigSupported(config);
          signal.throwIfAborted();
          if (!supported) throw new UnsupportedCodecError('平板浏览器无法解码这档画质。');
          if (workerRenderer) {
            workerRenderer.configure(config);
          } else {
            decoder = new VideoDecoder({
              output: draw,
              error: (error) => {
                decoderError = error;
                connection.abort();
              },
            });
            decoder.configure(config);
          }
        }
        needKeyframe = false;
        if (!firstFrameTimer && !status.hidden) {
          firstFrameTimer = setTimeout(() => stalled('等待首帧超时'), 7000);
        }
      }

      firstTimestamp ??= captureTime;
      lastTimestamp = Math.max(lastTimestamp + 1, Number((captureTime - firstTimestamp) / 1000n));
      if (workerRenderer) {
        workerRenderer.decode(bytes, lastTimestamp, keyframe, Number(captureTime) / 1e6);
      } else {
        decodeStarted.set(lastTimestamp, performance.now());
        decoder.decode(new EncodedVideoChunk({
          type: keyframe ? 'key' : 'delta', timestamp: lastTimestamp, data: bytes,
        }));
      }
    }
  } catch (error) {
    if (workerFailed) throw new RetryRendererError(`正在恢复低延迟画面。${decoderError.message}`);
    if (decoderError instanceof StalledDecoderError) throw decoderError;
    if (decoderError) throw new UnsupportedCodecError(`平板视频解码中断。${decoderError.message}`);
    throw error;
  } finally {
    clearTimeout(firstFrameTimer);
    connection.abort();
    closeDecoder();
    workerRenderer?.close();
    if (drawRequest !== undefined) cancelAnimationFrame(drawRequest);
    pendingFrame?.close();
    wakeLock?.then((lock) => lock?.release()).catch(() => {});
    if (!playbackSignal.aborted) resetMetrics();
  }
}

async function run(signal, lowLatency) {
  const [width, height] = screenPixels().sort((a, b) => b - a);
  const modes = [
    { codec: 'avc', compat: false },
    { codec: 'avc', compat: true },
  ];
  const requestedCodec = new URLSearchParams(location.search).get('codec');
  if (requestedCodec !== 'avc' && await prefersHevc(width, height)) modes.unshift({ codec: 'hevc', compat: false });
  let currentMode = 0;
  while (!signal.aborted) {
    try {
      await showStream(modes[currentMode], lowLatency, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof RetryRendererError) {
        showStatus(error.message);
        continue;
      }
      if (error instanceof StalledDecoderError) {
        currentMode = Math.min(currentMode + 1, modes.length - 1);
        showStatus('正在恢复副屏画面…');
        continue;
      }
      if (error instanceof UnsupportedCodecError && currentMode + 1 < modes.length) {
        currentMode += 1;
        showStatus('正在切换到兼容画质…');
      } else {
        showStatus(error instanceof TypeError ? 'USB 连接暂时不可用，正在重试…' : error.message);
        if (error instanceof UnsupportedCodecError) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function restartPlayback() {
  playback?.abort();
  resetMetrics();
  if (document.hidden) return;
  playback = new AbortController();
  showStatus('正在连接 Mac…');
  run(playback.signal, lowLatency);
}

if (!globalThis.VideoDecoder) {
  latencyButton.hidden = true;
  showStatus('此浏览器缺少实时视频解码功能，请使用鸿蒙系统浏览器打开。');
} else {
  try {
    const requested = new URLSearchParams(location.search).get('latency');
    lowLatency = requested === null ? localStorage.getItem('sidescreen-low-latency') === '1' : requested === 'low';
    if (requested !== null) localStorage.setItem('sidescreen-low-latency', lowLatency ? '1' : '0');
  } catch {}
  latencyButton.setAttribute('aria-pressed', String(lowLatency));
  latencyButton.addEventListener('click', () => {
    lowLatency = !lowLatency;
    latencyButton.setAttribute('aria-pressed', String(lowLatency));
    try { localStorage.setItem('sidescreen-low-latency', lowLatency ? '1' : '0'); } catch {}
    restartPlayback();
  });
  document.addEventListener('visibilitychange', restartPlayback);
  restartPlayback();
}
