const DOWN = 0;
const MOVE = 1;
const UP = 2;
const CANCEL = 3;

function encodeTouches(events) {
  const bytes = new Uint8Array(events.reduce((size, event) => size + 6 + event.points.length * 8, 0));
  const wire = new DataView(bytes.buffer);
  let offset = 0;
  for (const { action, points } of events) {
    bytes[offset++] = 2; // SideScreen touch message
    bytes[offset++] = points.length;
    for (const { x, y } of points) {
      wire.setFloat32(offset, x, true);
      wire.setFloat32(offset + 4, y, true);
      offset += 8;
    }
    wire.setInt32(offset, action, true);
    offset += 4;
  }
  return bytes;
}

export function bindTabletTouch(canvas, token, signal, getTransform, reconnect) {
  const pointers = new Map();
  const pending = [];
  let sending = false;
  let waitingForLift = false;

  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (pending.length && !signal.aborted) {
        const response = await fetch('/touch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-SideScreen-Stream': token },
          body: encodeTouches(pending.splice(0, 16)),
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        });
        if (!response.ok) throw new Error('Touch stream disconnected');
      }
    } catch {
      // A lost acknowledgement could follow a delivered click. Reconnect instead of replaying it.
      if (!signal.aborted) reconnect();
    } finally {
      sending = false;
    }
  }

  function send(action) {
    const event = { action, points: Array.from(pointers.values()) };
    if (action === MOVE && pending.at(-1)?.action === MOVE) {
      pending[pending.length - 1] = event;
    } else if (pending.length < 32) {
      pending.push(event);
    } else {
      reconnect();
      return;
    }
    flush();
  }

  function position(event) {
    const transform = getTransform();
    const rect = canvas.getBoundingClientRect();
    if (!transform || !rect.width || !rect.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    return { x: transform.flipX < 0 ? 1 - x : x, y: transform.flipY < 0 ? 1 - y : y };
  }

  function cancel() {
    if (pointers.size && !waitingForLift) send(CANCEL);
    pointers.clear();
    waitingForLift = false;
  }

  const options = { signal };
  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (pointers.size >= 2 || waitingForLift) return;
    const point = position(event);
    if (!point) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point);
    send(DOWN);
  }, options);
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId) || waitingForLift) return;
    const point = position(event);
    if (!point) return cancel();
    event.preventDefault();
    pointers.set(event.pointerId, point);
    send(MOVE);
  }, options);
  canvas.addEventListener('pointerup', (event) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    if (!waitingForLift) {
      const point = position(event);
      if (!point) return cancel();
      pointers.set(event.pointerId, point);
      send(UP);
    }
    pointers.delete(event.pointerId);
    // Lifting one of two fingers ends the gesture. The remaining finger must not become a tap.
    waitingForLift = pointers.size > 0;
  }, options);
  for (const type of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, (event) => { if (pointers.has(event.pointerId)) cancel(); }, options);
  }
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  window.addEventListener('blur', cancel, options);
}
