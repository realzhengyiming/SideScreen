const DISPLAY_CONFIG = 1;
const VIDEO_FRAME = 6;
const CODEC_SELECTED = 10;
const H264 = 1;
const MAX_FRAME_SIZE = 32 * 1024 * 1024;
const MAX_DECODE_QUEUE = 8;

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
}

fullscreen.hidden = !stage.requestFullscreen || !document.fullscreenEnabled;
fullscreen.addEventListener('click', () => stage.requestFullscreen().catch(console.warn));
new ResizeObserver(fitCanvas).observe(stage);

class UnsupportedCodecError extends Error {}

async function showStream() {
  const connection = new AbortController();
  let decoder;
  let decoderError;
  let pendingFrame;
  let drawRequest;
  let codecSelected = false;
  let width = 0;
  let height = 0;
  let firstTimestamp;
  let lastTimestamp = -1;
  let needKeyframe = true;
  let wakeLock;

  function stopWhenHidden() {
    if (document.hidden) connection.abort();
  }

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
        context.drawImage(latest, 0, 0, canvas.width, canvas.height);
        if (!status.hidden) {
          showStatus('');
          wakeLock = navigator.wakeLock?.request('screen').catch(() => undefined);
        }
      } finally {
        latest.close();
      }
    });
  }

  document.addEventListener('visibilitychange', stopWhenHidden);
  try {
    const response = await fetch('/stream', { signal: connection.signal });
    if (response.status === 503) throw new Error('请在 Mac 的 SideScreen 选择 USB 并点 Start。');
    if (response.status === 409) throw new Error('已有副屏页面在播放，请关闭另一标签页。');
    if (!response.ok || !response.body) throw new Error('USB 连接暂时不可用，正在重试…');
    const stream = new StreamReader(response.body);
    showStatus('已连接，等待 Mac 画面…');

    while (true) {
      const [message] = await stream.read(1);
      if (message === CODEC_SELECTED) {
        const [codec] = await stream.read(1);
        if (codec !== H264) throw new Error('请使用支持 H.264 的 SideScreen Mac 版。');
        codecSelected = true;
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
          closeDecoder();
          needKeyframe = true;
        }
        fitCanvas();
        continue;
      }

      if (message !== VIDEO_FRAME || !codecSelected || !width) {
        throw new Error('串流协议不匹配，请使用 SideScreen Mac 1.1.1 或更新版本。');
      }
      const header = view(await stream.read(13));
      const length = header.getUint32(0);
      if (length < 1 || length > MAX_FRAME_SIZE) throw new Error('视频帧长度异常。');
      const keyframe = (header.getUint8(4) & 1) !== 0;
      const captureTime = header.getBigUint64(5);
      const bytes = await stream.read(length);

      if (decoder && decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
        closeDecoder();
        needKeyframe = true;
      }
      if (needKeyframe) {
        if (!keyframe) continue;
        const config = {
          codec: codecFromKeyframe(bytes),
          codedWidth: width,
          codedHeight: height,
          optimizeForLatency: true,
        };
        const { supported } = await VideoDecoder.isConfigSupported(config);
        if (!supported) throw new UnsupportedCodecError('当前平板浏览器不支持这路 H.264 解码。');
        decoder = new VideoDecoder({
          output: draw,
          error: (error) => {
            decoderError = error;
            connection.abort();
          },
        });
        decoder.configure(config);
        needKeyframe = false;
      }

      firstTimestamp ??= captureTime;
      lastTimestamp = Math.max(lastTimestamp + 1, Number((captureTime - firstTimestamp) / 1000n));
      decoder.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta', timestamp: lastTimestamp, data: bytes,
      }));
    }
  } catch (error) {
    if (decoderError) throw new Error(`平板视频解码中断，正在重试。${decoderError.message}`);
    throw error;
  } finally {
    connection.abort();
    document.removeEventListener('visibilitychange', stopWhenHidden);
    closeDecoder();
    if (drawRequest !== undefined) cancelAnimationFrame(drawRequest);
    pendingFrame?.close();
    wakeLock?.then((lock) => lock?.release()).catch(() => {});
  }
}

async function run() {
  if (!globalThis.VideoDecoder || !context) {
    showStatus('此浏览器缺少实时视频解码功能，请使用鸿蒙系统浏览器打开。');
    return;
  }
  while (true) {
    if (document.hidden) {
      await new Promise((resolve) => document.addEventListener('visibilitychange', resolve, { once: true }));
      continue;
    }
    try {
      await showStream();
    } catch (error) {
      showStatus(error instanceof TypeError ? 'USB 连接暂时不可用，正在重试…' : error.message);
      if (error instanceof UnsupportedCodecError) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

run();
