import { createRenderer } from '/mvp/src/renderer.js';
import { createRuntimeClient } from '/mvp/src/runtime-client.js';
import { createLatentRoamer } from '/mvp/src/ui/latent-roamer.js';

const RUNTIME_BASE_URL = 'http://127.0.0.1:18090';
const statusElement = document.querySelector('[data-runtime-status]');
const generationElement = document.querySelector('[data-world-generation]');
const revisionElement = document.querySelector('[data-revision]');
const eventSeqElement = document.querySelector('[data-event-seq]');
const speciesElement = document.querySelector('[data-agent-species]');
const masterElement = document.querySelector('[data-agent-master]');
const canvas = document.querySelector('#world');
const renderer = createRenderer(canvas);
let latestSnapshot = null;
let reconnectDelayMs = 0;
let reconnectGate = null;
let releaseReconnect = null;
let activeSocket = null;

const diagnostics = {
  frameTypes: [],
  socketUrls: [],
  socketOpens: 0,
  snapshotPublishes: 0,
  lastCommandResult: null,
  decisions: [],
};

class DelayedWebSocket {
  constructor(url, delayMs, gate) {
    this.url = url;
    this.listeners = new Map();
    this.pendingClose = null;
    this.socket = null;
    Promise.resolve(gate).then(() => setTimeout(() => {
      if (this.pendingClose !== null) return;
      const socket = new WebSocket(url);
      this.socket = socket;
      activeSocket = this;
      socket.addEventListener('open', () => { diagnostics.socketOpens += 1; });
      for (const [type, listeners] of this.listeners) {
        for (const listener of listeners) socket.addEventListener(type, listener);
      }
      socket.addEventListener('message', (event) => {
        try { diagnostics.frameTypes.push(JSON.parse(event.data).type); } catch { /* protocol owns validation */ }
      });
    }, delayMs));
  }

  get readyState() {
    return this.socket?.readyState ?? WebSocket.CONNECTING;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
    this.socket?.addEventListener(type, listener);
  }

  send(payload) {
    this.socket.send(payload);
  }

  close(code, reason) {
    if (this.socket) this.socket.close(code, reason);
    else this.pendingClose = { code, reason };
  }
}

function webSocketFactory(url) {
  diagnostics.socketUrls.push(url);
  const delay = reconnectDelayMs;
  const gate = reconnectGate;
  reconnectDelayMs = 0;
  reconnectGate = null;
  return new DelayedWebSocket(url, delay, gate);
}

function countFrames(type) {
  return diagnostics.frameTypes.filter((frameType) => frameType === type).length;
}

function closeActiveSocket(reason) {
  const socket = activeSocket?.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('E2E_SOCKET_NOT_OPEN'));
  }
  const closed = new Promise((resolve) => {
    socket.addEventListener('close', () => resolve(Object.freeze({
      revision: client.getStatus().revision,
      patches: countFrames('state.patch'),
      snapshots: countFrames('snapshot'),
      socketOpens: diagnostics.socketOpens,
    })), { once: true });
  });
  socket.close(4000, reason);
  return closed;
}

const client = createRuntimeClient({
  fetchImpl: (...args) => fetch(...args),
  webSocketFactory,
  baseUrl: RUNTIME_BASE_URL,
});

const latentRoamer = createLatentRoamer({
  document,
  runtimeClient: { command: sendInteractiveCommand },
  fetchMap: async (voice) => {
    const response = await fetch(`${RUNTIME_BASE_URL}/api/v1/latent-maps/${voice}`);
    if (!response.ok) throw new Error('LATENT_MAP_UNAVAILABLE');
    return response.json();
  },
  getState: () => latestSnapshot,
  voice: 'melody',
});

function resize() {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  renderer.resize();
}

client.subscribe((snapshot, events, status) => {
  latestSnapshot = snapshot;
  latentRoamer.render(snapshot);
  diagnostics.snapshotPublishes += 1;
  statusElement.textContent = status.phase;
  generationElement.textContent = status.worldGeneration ?? '';
  revisionElement.textContent = String(status.revision);
  eventSeqElement.textContent = String(status.eventSeq);
  speciesElement.textContent = snapshot.agentStatus
    ? `${snapshot.agentStatus.species.source}:${snapshot.agentStatus.species.status}`
    : '';
  masterElement.textContent = snapshot.agentStatus
    ? `${snapshot.agentStatus.master.source}:${snapshot.agentStatus.master.status}`
    : '';
  for (const event of events) {
    if (event.name === 'decision') diagnostics.decisions.push(event.payload);
  }
});

async function sendCommandWithRevisionRetry(targetClient, name, payload = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await targetClient.command(name, payload);
    if (result.code !== 'REVISION_MISMATCH') return result;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error('COMMAND_REVISION_RETRY_EXHAUSTED');
}

async function sendInteractiveCommand(name, payload = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await client.command(name, payload);
    diagnostics.lastCommandResult = Object.freeze(Object.fromEntries(
      ['commandId', 'accepted', 'code', 'paused', 'voice', 'mode', 'active']
        .filter((key) => Object.hasOwn(result, key))
        .map((key) => [key, result[key]]),
    ));
    if (result.code !== 'REVISION_MISMATCH') return result;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error('COMMAND_REVISION_RETRY_EXHAUSTED');
}

for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', () => {
    sendInteractiveCommand(button.dataset.command, {})
      .catch((error) => { statusElement.textContent = error.code ?? error.message; });
  });
}

for (const button of document.querySelectorAll('[data-open-latent]')) {
  button.addEventListener('click', () => {
    latentRoamer.open(button.dataset.openLatent)
      .catch((error) => { statusElement.textContent = error.code ?? error.message; });
  });
}

function paint() {
  if (latestSnapshot !== null) renderer.render(latestSnapshot);
  requestAnimationFrame(paint);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(paint);

globalThis.__candidateRuntime = Object.freeze({
  client,
  diagnostics,
  closeSocketAfter(delayMs = 0) {
    reconnectDelayMs = delayMs;
    return closeActiveSocket('E2E_RECONNECT');
  },
  closeSocketAndHold() {
    reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
    return closeActiveSocket('E2E_RECONNECT_HOLD');
  },
  releaseReconnect() {
    releaseReconnect?.();
    releaseReconnect = null;
  },
  async advanceRuntimeRecords(count) {
    const driver = createRuntimeClient({
      fetchImpl: (...args) => fetch(...args),
      webSocketFactory: (url) => new WebSocket(url),
      baseUrl: RUNTIME_BASE_URL,
    });
    try {
      await driver.connect();
      let paused = driver.getSnapshot().paused;
      for (let index = 0; index < count; index += 1) {
        paused = !paused;
        const result = await sendCommandWithRevisionRetry(
          driver,
          paused ? 'runtime.pause' : 'runtime.resume',
        );
        if (result.code !== 'OK') throw new Error(`E2E_DRIVER_${result.code}`);
      }
      return driver.getStatus();
    } finally {
      driver.disconnect();
    }
  },
  command(name, payload = {}) {
    return sendInteractiveCommand(name, payload);
  },
  openLatent(voice = 'melody') {
    return latentRoamer.open(voice);
  },
  closeLatent() {
    return latentRoamer.close();
  },
  status() {
    return client.getStatus();
  },
});

client.connect().then(() => {
  const status = client.getStatus();
  statusElement.textContent = status.phase;
  generationElement.textContent = status.worldGeneration ?? '';
  revisionElement.textContent = String(status.revision);
  eventSeqElement.textContent = String(status.eventSeq);
}).catch((error) => {
  statusElement.textContent = error.code ?? error.message;
});
