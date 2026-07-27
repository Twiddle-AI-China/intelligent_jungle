const VOICES = new Set(['bass', 'pad', 'melody']);
const HEARTBEAT_MS = 750;

function clamp(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function stateFor(snapshot, voice) {
  return snapshot?.latent?.[voice] ?? snapshot?.[voice] ?? null;
}

function validMap(value, voice) {
  return value && value.voice === voice && Array.isArray(value.points)
    && value.points.every((point) => typeof point?.id === 'string'
      && Number.isFinite(point.x) && Number.isFinite(point.y))
    && Array.isArray(value.neighbors)
    && value.cursor && Number.isFinite(value.cursor.x) && Number.isFinite(value.cursor.y);
}

export function createLatentRoamer({
  document,
  runtimeClient,
  fetchMap,
  getState,
  voice: initialVoice = 'melody',
  onClose = () => {},
} = {}) {
  if (!document || typeof runtimeClient?.command !== 'function'
    || typeof fetchMap !== 'function' || typeof getState !== 'function'
    || !VOICES.has(initialVoice) || typeof onClose !== 'function') {
    throw new Error('LATENT_ROAMER_OPTIONS_INVALID');
  }

  let currentVoice = initialVoice;
  let currentMap = null;
  let authoritative = null;
  let leaseToken = null;
  let cursorEventSeq = 0;
  let openGeneration = 0;
  let heartbeatHandle = null;
  let root = null;
  let canvas = null;
  let context = null;
  let live = null;
  let previewButton = null;
  let previewAttempt = 0;
  let dragging = false;
  let destroyed = false;

  function announce(message) {
    if (live && live.textContent !== message) live.textContent = message;
  }

  function stopHeartbeat() {
    if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }

  async function heartbeat() {
    const token = leaseToken;
    const generation = openGeneration;
    const voice = currentVoice;
    if (!token || !root) return;
    try {
      const result = await runtimeClient.command('control.heartbeat', {
        voice, leaseToken: token,
      });
      if (generation !== openGeneration || voice !== currentVoice || token !== leaseToken) return;
      if (!result.accepted) {
        leaseToken = null;
        stopHeartbeat();
        announce(`control unavailable: ${result.code}`);
      }
    } catch {
      if (generation !== openGeneration || voice !== currentVoice || token !== leaseToken) return;
      leaseToken = null;
      stopHeartbeat();
      announce('control disconnected');
    }
  }

  function beginHeartbeat() {
    stopHeartbeat();
    heartbeatHandle = setInterval(() => { heartbeat(); }, HEARTBEAT_MS);
  }

  function draw() {
    if (!context || !canvas || !currentMap) return;
    const width = canvas.width;
    const height = canvas.height;
    const toCanvas = (x, y) => [
      width * (clamp(x) + 1) / 2,
      height * (1 - (clamp(y) + 1) / 2),
    ];
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#f2ead8';
    context.fillRect(0, 0, width, height);
    const neighbors = new Set(authoritative?.neighbors ?? currentMap.neighbors);
    currentMap.points.forEach((point, index) => {
      const [x, y] = toCanvas(point.x, point.y);
      context.fillStyle = neighbors.has(index) ? '#e75c26' : '#2e3e8f';
      context.beginPath();
      context.arc(x, y, neighbors.has(index) ? 4 : 2, 0, Math.PI * 2);
      context.fill();
    });
    const cursor = authoritative?.cursor ?? currentMap.cursor;
    const [x, y] = toCanvas(cursor.x, cursor.y);
    context.strokeStyle = '#e75c26';
    context.lineWidth = 2;
    context.strokeRect(x - 9, y - 9, 18, 18);
    announce(`${currentVoice} · X ${cursor.x.toFixed(3)} · Y ${cursor.y.toFixed(3)}`);
  }

  function ensureView() {
    if (root) return;
    root = document.createElement('section');
    root.className = 'candidate-latent-roamer';
    root.setAttribute('aria-label', 'Authoritative latent map');

    canvas = document.createElement('canvas');
    canvas.className = 'candidate-latent-map';
    canvas.width = 480;
    canvas.height = 320;
    canvas.tabIndex = 0;
    context = canvas.getContext('2d');

    previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.textContent = 'hold preview';
    previewButton.dataset.preview = 'hold';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = 'close';
    closeButton.dataset.latentClose = 'true';
    closeButton.addEventListener('click', () => { close(); });

    live = document.createElement('output');
    live.className = 'candidate-latent-live';
    live.setAttribute('aria-live', 'polite');

    root.appendChild(canvas);
    root.appendChild(previewButton);
    root.appendChild(closeButton);
    root.appendChild(live);
    document.body.appendChild(root);

    canvas.addEventListener('pointerdown', (event) => {
      dragging = true;
      canvas.setPointerCapture?.(event.pointerId);
      sendCursor(event);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (dragging) sendCursor(event);
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
    canvas.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      const delta = event.shiftKey ? 0.1 : 0.025;
      const cursor = authoritative?.cursor;
      if (!cursor || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      sendNormalizedCursor(
        cursor.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0),
        cursor.y + (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0),
      );
    });
    previewButton.addEventListener('pointerdown', () => { preview(true); });
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
      previewButton.addEventListener(name, () => { preview(false); });
    }
  }

  function sendNormalizedCursor(x, y) {
    if (!leaseToken || !authoritative) return Promise.resolve(null);
    cursorEventSeq += 1;
    const pca = authoritative.mode === 'pca'
      ? [...(authoritative.cursor?.pca ?? [])] : [];
    return runtimeClient.command('latent.setCursor', {
      voice: currentVoice,
      leaseToken,
      eventSeq: cursorEventSeq,
      cursor: { x: clamp(x), y: clamp(y), pca },
    }).then((result) => {
      if (!result.accepted) announce(`cursor rejected: ${result.code}`);
      return result;
    }).catch(() => {
      announce('cursor disconnected');
      return null;
    });
  }

  function sendCursor(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = 1 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2;
    return sendNormalizedCursor(x, y);
  }

  function preview(start) {
    if (!leaseToken) return Promise.resolve(null);
    const generation = openGeneration;
    const voice = currentVoice;
    const token = leaseToken;
    const button = previewButton;
    const attempt = ++previewAttempt;
    button.disabled = true;
    announce(start ? 'preview pending' : 'preview release pending');
    return runtimeClient.command(start ? 'preview.start' : 'preview.stop', {
      voice, leaseToken: token,
    }).then((result) => {
      const current = generation === openGeneration && attempt === previewAttempt
        && voice === currentVoice && token === leaseToken && button === previewButton;
      if (current) {
        button.disabled = false;
        if (!result.accepted) announce(`preview rejected: ${result.code}`);
      }
      return result;
    }).catch(() => {
      const current = generation === openGeneration && attempt === previewAttempt
        && voice === currentVoice && token === leaseToken && button === previewButton;
      if (current) {
        button.disabled = false;
        announce('preview disconnected');
      }
      return null;
    });
  }

  async function open(nextVoice = currentVoice) {
    if (destroyed) throw new Error('LATENT_ROAMER_DESTROYED');
    if (!VOICES.has(nextVoice)) throw new Error('LATENT_VOICE_UNAVAILABLE');
    if (root && leaseToken && nextVoice === currentVoice) return true;
    const generation = ++openGeneration;
    const priorToken = leaseToken;
    const priorVoice = currentVoice;
    if (priorToken) {
      leaseToken = null;
      stopHeartbeat();
      try {
        await runtimeClient.command('preview.stop', {
          voice: priorVoice, leaseToken: priorToken,
        });
        await runtimeClient.command('control.release', {
          voice: priorVoice, leaseToken: priorToken,
        });
      } catch {
        // Exact socket cleanup or TTL remains the authoritative fallback.
      }
      if (generation !== openGeneration || !root) return false;
    }
    currentVoice = nextVoice;
    currentMap = null;
    authoritative = null;
    leaseToken = null;
    stopHeartbeat();
    ensureView();
    announce('map loading');
    let loaded;
    try { loaded = await fetchMap(nextVoice); } catch {
      if (generation === openGeneration && root) announce('map unavailable');
      return false;
    }
    if (generation !== openGeneration || !root) return false;
    if (!validMap(loaded, nextVoice)) {
      announce('map unavailable');
      return false;
    }
    currentMap = loaded;
    render(getState());
    let result;
    try {
      result = await runtimeClient.command('control.take', { voice: nextVoice });
    } catch {
      if (generation === openGeneration && root) announce('control disconnected');
      return false;
    }
    if (generation !== openGeneration || !root) {
      if (result.accepted && result.leaseToken) {
        runtimeClient.command('control.release', {
          voice: nextVoice, leaseToken: result.leaseToken,
        }).catch(() => {});
      }
      return false;
    }
    if (!result.accepted || typeof result.leaseToken !== 'string') {
      announce(`control rejected: ${result.code}`);
      return false;
    }
    leaseToken = result.leaseToken;
    cursorEventSeq = 0;
    beginHeartbeat();
    announce('control acquired');
    return true;
  }

  async function close() {
    openGeneration += 1;
    previewAttempt += 1;
    dragging = false;
    stopHeartbeat();
    const token = leaseToken;
    const closingVoice = currentVoice;
    leaseToken = null;
    if (root?.parentNode) root.parentNode.removeChild(root);
    root = null;
    canvas = null;
    context = null;
    live = null;
    previewButton = null;
    onClose();
    if (!token) return true;
    try {
      await runtimeClient.command('preview.stop', { voice: closingVoice, leaseToken: token });
      await runtimeClient.command('control.release', { voice: closingVoice, leaseToken: token });
    } catch {
      // Exact socket detach is the authoritative fallback cleanup.
    }
    return true;
  }

  function render(snapshot) {
    if (!root || !currentMap) return false;
    const next = stateFor(snapshot, currentVoice);
    if (!next || !next.cursor) return false;
    authoritative = next;
    if (next.owner !== 'USER' || next.control?.held !== true) {
      leaseToken = null;
      stopHeartbeat();
    }
    if (previewButton) previewButton.dataset.active = String(next.preview?.active === true);
    draw();
    return true;
  }

  function destroy() {
    destroyed = true;
    return close();
  }

  return Object.freeze({ open, close, render, destroy });
}
