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
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
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
  const scale = Math.min(
    stage.clientWidth / canvas.width,
    stage.clientHeight / canvas.height,
  );
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
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

function monitorStream(signal) {
  const recentPings = [];
  let clockOffset;
  let delayAverage;
  let lastUpdate = -Infinity;

  async function measurePing() {
    while (!signal.aborted) {
      const start = performance.now();
      try {
        const response = await fetch('/ping', { signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) });
        const end = performance.now();
        signal.throwIfAborted();
        const received = parseFloat(response.headers.get('X-SideScreen-Received-Us')) / 1000;
        const sent = parseFloat(response.headers.get('X-SideScreen-Sent-Us')) / 1000;
        if (response.status !== 204 || !Number.isFinite(received) || !Number.isFinite(sent) || sent < received) {
          throw new Error('Ping unavailable');
        }

        // Estimate the clock difference from the exchange with the least queuing delay.
        const rtt = Math.max(0, (end - start) - (sent - received));
        const offset = ((received - start) + (sent - end)) / 2;
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

  measurePing();
  return (encodedAt) => {
    if (clockOffset === undefined) return;
    const now = performance.now();
    const delay = Math.max(0, now + clockOffset - encodedAt);
    delayAverage = delayAverage === undefined ? delay : 0.85 * delayAverage + 0.15 * delay;
    if (now - lastUpdate >= 500) {
      frameDelayValue.textContent = `≈ ${Math.round(delayAverage)} ms`;
      lastUpdate = now;
    }
  };
}

fullscreen.hidden = !stage.requestFullscreen || !document.fullscreenEnabled;
fullscreen.addEventListener('click', () => stage.requestFullscreen().catch(console.warn));
new ResizeObserver(fitCanvas).observe(stage);

class UnsupportedCodecError extends Error {}

function decoderConfig(codec, width, height) {
  return { codec, codedWidth: width, codedHeight: height, optimizeForLatency: true };
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
  const maxDecodeQueue = lowLatency ? 3 : 8;
  let decoder;
  let decoderError;
  let pendingFrame;
  let drawRequest;
  let measureFrame;
  let avc = false;
  let width = 0;
  let height = 0;
  let firstTimestamp;
  let lastTimestamp = -1;
  let needKeyframe = true;
  let wakeLock;
  let firstFrameTimer;

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = undefined;
  }

  function draw(frame) {
    pendingFrame?.close();
    pendingFrame = frame;
    if (drawRequest !== undefined) return;
    drawRequest = requestAnimationFrame(() => {
      const latest = pendingFrame;
      pendingFrame = undefined;
      drawRequest = undefined;
      try {
        if (signal.aborted) return;
        context.drawImage(latest, 0, 0, canvas.width, canvas.height);
        measureFrame(Number(firstTimestamp) / 1e6 + latest.timestamp / 1000);
        if (!status.hidden) {
          clearTimeout(firstFrameTimer);
          showStatus('');
          resolution.textContent = `USB · ${canvas.width}×${canvas.height}`;
          resolution.hidden = false;
          wakeLock ??= navigator.wakeLock?.request('screen').catch(() => undefined);
        }
      } finally {
        latest.close();
      }
    });
  }

  try {
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
    measureFrame = monitorStream(signal);
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
          canvas.width = width;
          canvas.height = height;
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

      if (decoder && decoder.decodeQueueSize >= maxDecodeQueue) {
        closeDecoder();
        needKeyframe = true;
      }
      if (needKeyframe) {
        if (!keyframe) continue;
        const config = decoderConfig(avc ? codecFromKeyframe(bytes) : HEVC_MAIN, width, height);
        const { supported } = await VideoDecoder.isConfigSupported(config);
        signal.throwIfAborted();
        if (!supported) throw new UnsupportedCodecError('平板浏览器无法解码这档画质。');
        decoder = new VideoDecoder({
          output: draw,
          error: (error) => {
            decoderError = error;
            connection.abort();
          },
        });
        decoder.configure(config);
        needKeyframe = false;
        if (!firstFrameTimer && !status.hidden) {
          firstFrameTimer = setTimeout(() => {
            decoderError = new Error('等待首帧超时');
            connection.abort();
          }, 7000);
        }
      }

      firstTimestamp ??= captureTime;
      lastTimestamp = Math.max(lastTimestamp + 1, Number((captureTime - firstTimestamp) / 1000n));
      decoder.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta', timestamp: lastTimestamp, data: bytes,
      }));
    }
  } catch (error) {
    if (decoderError) throw new UnsupportedCodecError(`平板视频解码中断。${decoderError.message}`);
    throw error;
  } finally {
    clearTimeout(firstFrameTimer);
    connection.abort();
    closeDecoder();
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
  if (await prefersHevc(width, height)) modes.unshift({ codec: 'hevc', compat: false });
  let currentMode = 0;
  while (!signal.aborted) {
    try {
      await showStream(modes[currentMode], lowLatency, signal);
    } catch (error) {
      if (signal.aborted) return;
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

if (!globalThis.VideoDecoder || !context) {
  latencyButton.hidden = true;
  showStatus('此浏览器缺少实时视频解码功能，请使用鸿蒙系统浏览器打开。');
} else {
  try { lowLatency = localStorage.getItem('sidescreen-low-latency') === '1'; } catch {}
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
