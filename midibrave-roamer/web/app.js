import { PolyphonicInputRouter } from './input-router.js';
import { MidiInputController } from './midi-input.js';
import { PolyphonicVoiceAllocator } from './voice-allocator.js';
import { WanderMotion } from './wander-motion.js';
import { createMapTransform, createRangeTransform } from './map-transform.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  model: $('#model'), knn: $('#knn'), knnValue: $('#knn-value'), connection: $('#connection'),
  cursor: $('#cursor'), meta: $('#model-meta'), canvas: $('#map'), mapLayout: $('#map-layout'),
  roamMode: $('#roam-mode'), knnControl: $('#knn-control'),
  wander: $('#wander'),
  wanderSpeed: $('#wander-speed'), wanderSpeedValue: $('#wander-speed-value'),
  wanderTurn: $('#wander-turn'), wanderTurnValue: $('#wander-turn-value'),
  midiControl: $('#midi-control'), midiInput: $('#midi-input'), midiStatus: $('#midi-status'),
};

const context = ui.canvas.getContext('2d');
const voice = window.FlockVoiceClient.create({ fallbackEnabled: false, poolSize: 16 });
let manifest;
let model;
let latentMap;
let mapTransform;
let mapPoints = [];
const trail = [];
let cursor = { x: 0, y: 0 };
let dragging = false;
let wandering = false;
let wanderFrame = null;
let activeRows = [];
let connectPromise = null;
let midiAccess = null;
let midiPromise = null;
let midiRetryOnGesture = false;
let midiBlocked = false;
let keyboardRoot = 60;
let voiceSyncRevision = 0;
const inputRouter = new PolyphonicInputRouter();
const midiInputController = new MidiInputController(inputRouter, { normalizeMidi: clampPlayableNote });
const voiceAllocator = new PolyphonicVoiceAllocator();
const wanderMotion = new WanderMotion();
const COMPUTER_KEYS = new Map([
  ['KeyA', 0], ['KeyW', 1], ['KeyS', 2], ['KeyE', 3], ['KeyD', 4],
  ['KeyF', 5], ['KeyT', 6], ['KeyG', 7], ['KeyY', 8], ['KeyH', 9],
  ['KeyU', 10], ['KeyJ', 11], ['KeyK', 12],
]);

function clamp(value) { return Math.max(-1, Math.min(1, Number(value) || 0)); }
function clampTo(value, boundary) { return Math.max(-boundary, Math.min(boundary, Number(value) || 0)); }
function rows() { return activeRows.length ? activeRows : [0]; }
function clampPlayableNote(midi) { return window.FlockVoiceClient.clampMidi(midi); }
function usesFreePca() { return ui.roamMode.value === 'pca'; }

async function ensureConnected() {
  if (voice.mode === 'streaming' || voice.mode === 'fallback') return voice.getState();
  if (!connectPromise) {
    connectPromise = voice.connect(window.location.origin).finally(() => { connectPromise = null; });
  }
  return connectPromise;
}

function applyVoiceActions(actions) {
  for (const action of actions) {
    if (action.type === 'release') voice.release(action.row);
    else if (action.type === 'panic') voice.panic(action.row);
    else voice.hold(action.row, action.midi, action.velocity);
  }
}

async function syncPlayableVoices() {
  const revision = ++voiceSyncRevision;
  let desired = inputRouter.active();
  if (!desired.length) {
    applyVoiceActions(voiceAllocator.plan([], rows()));
    return;
  }
  await ensureConnected();
  if (revision !== voiceSyncRevision) return;
  desired = inputRouter.active();
  applyVoiceActions(voiceAllocator.plan(desired, rows()));
}

function requestVoiceSync() {
  syncPlayableVoices().catch((error) => { ui.connection.textContent = error.message; });
}

function startPlayableNote(id, midi, velocity, metadata) {
  inputRouter.press(id, {
    ...metadata,
    midi: clampPlayableNote(midi),
    velocity,
  });
  requestVoiceSync();
}

function stopPlayableNote(id) {
  if (inputRouter.release(id)) requestVoiceSync();
}

function releaseWhere(predicate) {
  if (inputRouter.clearWhere(predicate)) requestVoiceSync();
}

function releasePlayableNotes() {
  midiInputController.clearState();
  inputRouter.clear();
  requestVoiceSync();
}

function reportAutomaticError(output, prefix, error) {
  output.textContent = `${prefix}: ${error.message}`;
}
function mapPoint(point) {
  return mapTransform.toView(point);
}
function pcaPoint(point) {
  const scale = Number(latentMap?.pca_basis?.xy_scale) || 1;
  return { x: Number(point.px) * scale, y: Number(point.py) * scale };
}
function canvasPoint(value) {
  return [(value.x + 1) * ui.canvas.width / 2, (1 - value.y) * ui.canvas.height / 2];
}

function draw() {
  const { width: w, height: h } = ui.canvas;
  context.fillStyle = '#0b0f15';
  context.fillRect(0, 0, w, h);
  // 坐标网格：细发线，中轴略强
  context.lineWidth = 1;
  for (let i = 0; i <= 8; i += 1) {
    const gx = (i / 8) * w;
    const gy = (i / 8) * h;
    context.strokeStyle = i === 4 ? 'rgba(150,170,190,0.20)' : 'rgba(150,170,190,0.07)';
    context.beginPath(); context.moveTo(gx, 0); context.lineTo(gx, h); context.stroke();
    context.beginPath(); context.moveTo(0, gy); context.lineTo(w, gy); context.stroke();
  }
  // 四边刻度
  context.strokeStyle = 'rgba(150,170,190,0.28)';
  for (let i = 0; i <= 32; i += 1) {
    const tx = (i / 32) * w;
    const ty = (i / 32) * h;
    const len = i % 4 === 0 ? 14 : 7;
    context.beginPath(); context.moveTo(tx, 0); context.lineTo(tx, len); context.stroke();
    context.beginPath(); context.moveTo(tx, h); context.lineTo(tx, h - len); context.stroke();
    context.beginPath(); context.moveTo(0, ty); context.lineTo(len, ty); context.stroke();
    context.beginPath(); context.moveTo(w, ty); context.lineTo(w - len, ty); context.stroke();
  }
  if (!latentMap) return;
  const [cx, cy] = canvasPoint(cursor);
  // 漫游轨迹：最新段最亮
  context.lineWidth = 3;
  for (let i = trail.length - 1; i > 0; i -= 1) {
    const [x1, y1] = canvasPoint(trail[i]);
    const [x0, y0] = canvasPoint(trail[i - 1]);
    context.strokeStyle = `rgba(255,90,54,${((1 - i / trail.length) * 0.5).toFixed(3)})`;
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(x0, y0); context.stroke();
  }
  // 音色点云：直角小方点
  context.fillStyle = 'rgba(158,180,200,0.75)';
  for (const point of mapPoints) {
    const [x, y] = canvasPoint(point);
    context.fillRect(x - 2.5, y - 2.5, 5, 5);
  }
  if (!usesFreePca()) {
    // 安全地图模式才存在 kNN；PCA 模式画连线会虚构并不存在的邻居混合。
    const neighbors = mapPoints
      .map((point, index) => [index, mapTransform.distanceSquared(point, cursor)])
      .sort((a, b) => a[1] - b[1])
      .slice(0, Number(ui.knn.value));
    context.strokeStyle = 'rgba(255,90,54,0.30)';
    context.lineWidth = 2;
    context.fillStyle = '#ff5a36';
    for (const [index] of neighbors) {
      const [nx, ny] = canvasPoint(mapPoints[index]);
      context.beginPath(); context.moveTo(cx, cy); context.lineTo(nx, ny); context.stroke();
      context.fillRect(nx - 5, ny - 5, 10, 10);
    }
  }
  // 十字准线 + 光标
  context.strokeStyle = 'rgba(255,90,54,0.22)';
  context.lineWidth = 1;
  context.beginPath(); context.moveTo(cx, 0); context.lineTo(cx, h); context.stroke();
  context.beginPath(); context.moveTo(0, cy); context.lineTo(w, cy); context.stroke();
  context.strokeStyle = '#ff5a36';
  context.lineWidth = 3;
  context.beginPath(); context.arc(cx, cy, 18, 0, Math.PI * 2); context.stroke();
  context.fillStyle = '#ff5a36';
  context.fillRect(cx - 3, cy - 3, 6, 6);
}

function sendCursor(next) {
  if (!latentMap || !model) return;
  const boundary = usesFreePca() ? mapTransform.viewHalf : 1;
  cursor = { x: clampTo(next.x, boundary), y: clampTo(next.y, boundary) };
  const raw = mapTransform.toMap(cursor);
  for (const targetRow of rows()) {
    if (usesFreePca()) {
      const dims = Number(latentMap.pca_basis.dims) || 2;
      const coefficients = Array.from({ length: dims }, (_, index) => (
        index === 0 ? raw.x : index === 1 ? raw.y : 0
      ));
      voice.setParams(targetRow, { timbrePCA: coefficients, timbreXY: null });
    } else {
      voice.setParams(targetRow, {
        timbrePCA: null,
        timbreXY: [raw.x, raw.y],
        timbreK: Number(ui.knn.value),
      });
    }
  }
  ui.cursor.textContent = `X ${cursor.x.toFixed(2)}  Y ${cursor.y.toFixed(2)}`;
  const last = trail[0];
  if (!last || Math.hypot(last.x - cursor.x, last.y - cursor.y) > 0.006) {
    trail.unshift({ ...cursor });
    if (trail.length > 90) trail.pop();
  }
  draw();
}

function configureRoamSpace() {
  const pca = latentMap?.pca_basis;
  const canUsePca = pca?.dims >= 2 && pca?.ranges?.length >= 2;
  if (usesFreePca() && !canUsePca) ui.roamMode.value = 'map';

  if (usesFreePca()) {
    mapTransform = createRangeTransform({
      x: [pca.ranges[0].p5, pca.ranges[0].p95],
      y: [pca.ranges[1].p5, pca.ranges[1].p95],
    });
    mapPoints = latentMap.points.map((point) => {
      const view = mapPoint(pcaPoint(point));
      return { x: clampTo(view.x, 0.95), y: clampTo(view.y, 0.95) };
    });
    ui.knnControl.hidden = true;
    ui.mapLayout.textContent = '潜空间 · PCA PC1/PC2';
    ui.meta.textContent = `${model.displayName} · 4 复音 · ${pca.dims}D PCA`;
  } else {
    mapTransform = createMapTransform(latentMap.points);
    mapPoints = latentMap.points.map(mapPoint);
    ui.knnControl.hidden = false;
    const layoutLabel = latentMap.layout === 'tsne' ? 't-SNE' : String(latentMap.layout || '2D').toUpperCase();
    ui.mapLayout.textContent = `音色地图 · ${layoutLabel}`;
    ui.meta.textContent = `${model.displayName} · 4 复音 · ${latentMap.points.length} 个音色点`;
  }
  cursor = { x: 0, y: 0 };
  trail.length = 0;
  if (wandering) wanderMotion.reset(cursor, performance.now());
  sendCursor(cursor);
}

function pointerCursor(event) {
  const rect = ui.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    y: 1 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2,
  };
}

async function selectModel() {
  const nextModel = manifest.models.find((entry) => entry.id === ui.model.value) ?? manifest.models[0];
  const nextRows = nextModel?.compatibility?.polyphonyRows
    ?? [nextModel?.compatibility?.row ?? 0];
  const response = await fetch(`./models/maps/${nextModel.map}`);
  if (!response.ok) throw new Error(`map unavailable: ${nextModel.map}`);
  latentMap = await response.json();
  if (latentMap.voice !== nextModel.compatibility.backendVoice) throw new Error('model/map binding mismatch');
  model = nextModel;
  activeRows = nextRows.slice(0, 4).map(Number);
  for (const targetRow of rows()) {
    voice.setParams(targetRow, { timbre: model.compatibility.mockTimbre, timbreXY: null, timbrePCA: null });
  }
  configureRoamSpace();
  requestVoiceSync();
}

function stopWander() {
  wandering = false;
  ui.wander.setAttribute('aria-pressed', 'false');
  ui.wander.textContent = '自动漫游';
  if (wanderFrame !== null) cancelAnimationFrame(wanderFrame);
  wanderFrame = null;
}

function wander(time) {
  if (!wandering) return;
  sendCursor(wanderMotion.step(cursor, time, {
    speed: 0.04 + Number(ui.wanderSpeed.value) / 100 * 0.7,
    turnRate: 2 * Math.pow(Number(ui.wanderTurn.value) / 100, 2),
    boundary: usesFreePca() ? mapTransform.viewHalf : 0.88,
  }));
  wanderFrame = requestAnimationFrame(wander);
}

function refreshWanderControls() {
  const speed = 0.04 + Number(ui.wanderSpeed.value) / 100 * 0.7;
  const turns = 2 * Math.pow(Number(ui.wanderTurn.value) / 100, 2);
  ui.wanderSpeedValue.textContent = `${speed.toFixed(2)}/s`;
  ui.wanderTurnValue.textContent = `${turns.toFixed(2)}/s`;
}

function acceptsPianoKeyboard(event) {
  const tag = event.target?.tagName?.toLowerCase();
  return !event.metaKey && !event.ctrlKey && !event.altKey
    && !['input', 'select', 'button', 'textarea'].includes(tag);
}

function refreshMidiInputs() {
  const selected = ui.midiInput.value || 'all';
  ui.midiInput.replaceChildren(new Option('All inputs', 'all'));
  const inputs = midiAccess
    ? Array.from(midiAccess.inputs.values()).filter((input) => input.state !== 'disconnected')
    : [];
  for (const input of inputs) {
    ui.midiInput.add(new Option(input.name || input.manufacturer || input.id, input.id));
    input.onmidimessage = handleMidiMessage;
  }
  const connectedIds = new Set(inputs.map((input) => input.id));
  if (midiInputController.disconnectMissing(connectedIds)) requestVoiceSync();
  ui.midiInput.value = inputs.some((input) => input.id === selected) ? selected : 'all';
  ui.midiControl.hidden = inputs.length < 2;
  ui.midiStatus.textContent = inputs.length
    ? `${inputs.length} 个 MIDI 输入 · 键盘 C${keyboardRoot / 12 - 1}`
    : `键盘 C${keyboardRoot / 12 - 1} · 未检测到 MIDI`;
}

function handleMidiMessage(event) {
  if (ui.midiInput.value !== 'all' && event.currentTarget.id !== ui.midiInput.value) return;
  if (midiInputController.handleMessage(event.currentTarget.id, event.data)) requestVoiceSync();
}

async function ensureMidiAccess({ fromGesture = false } = {}) {
  if (midiAccess) return midiAccess;
  if (!navigator.requestMIDIAccess) {
    ui.midiStatus.textContent = `键盘 C${keyboardRoot / 12 - 1} · MIDI 不可用`;
    return null;
  }
  if (midiPromise) return midiPromise;
  if (midiBlocked) return null;
  if (!fromGesture && midiRetryOnGesture) return null;
  midiPromise = navigator.requestMIDIAccess({ sysex: false })
    .then((access) => {
      midiAccess = access;
      midiRetryOnGesture = false;
      midiBlocked = false;
      midiAccess.onstatechange = refreshMidiInputs;
      refreshMidiInputs();
      return access;
    })
    .catch((error) => {
      midiRetryOnGesture = !fromGesture;
      midiBlocked = fromGesture;
      ui.midiStatus.textContent = fromGesture
        ? `键盘 C${keyboardRoot / 12 - 1} · MIDI 未授权`
        : `键盘 C${keyboardRoot / 12 - 1} · MIDI 自动识别`;
      return null;
    })
    .finally(() => { midiPromise = null; });
  return midiPromise;
}

function activateAutomatically(fromGesture = false) {
  if (fromGesture && voice.context.state === 'suspended') {
    voice.context.resume().catch(() => { /* browser policy remains authoritative */ });
  }
  ensureConnected().catch((error) => reportAutomaticError(ui.connection, 'connection', error));
  ensureMidiAccess({ fromGesture }).catch((error) => reportAutomaticError(ui.midiStatus, 'MIDI', error));
}

voice.onStateChange((state) => {
  const labels = {
    idle: '准备中', connecting: '连接中', streaming: '已连接',
    fallback: '降级模式', closed: '已断开',
  };
  ui.connection.dataset.mode = state.mode;
  ui.connection.textContent = state.reason
    ? `${labels[state.mode] ?? state.mode} · ${state.reason}`
    : labels[state.mode] ?? state.mode;
});

ui.canvas.addEventListener('pointerdown', (event) => {
  stopWander(); dragging = true; ui.canvas.setPointerCapture?.(event.pointerId); sendCursor(pointerCursor(event));
});
ui.canvas.addEventListener('pointermove', (event) => { if (dragging) sendCursor(pointerCursor(event)); });
ui.canvas.addEventListener('pointerup', () => { dragging = false; });
ui.canvas.addEventListener('pointercancel', () => { dragging = false; });
ui.knn.addEventListener('input', () => { ui.knnValue.textContent = ui.knn.value; sendCursor(cursor); });
ui.roamMode.addEventListener('change', configureRoamSpace);
ui.wanderSpeed.addEventListener('input', refreshWanderControls);
ui.wanderTurn.addEventListener('input', refreshWanderControls);
ui.model.addEventListener('change', () => selectModel().catch((error) => { ui.connection.textContent = error.message; }));
ui.midiInput.addEventListener('change', () => {
  if (midiInputController.releaseAll()) requestVoiceSync();
});
ui.wander.addEventListener('click', () => {
  if (wandering) { stopWander(); return; }
  activateAutomatically(true);
  wandering = true;
  wanderMotion.reset(cursor, performance.now());
  ui.wander.setAttribute('aria-pressed', 'true');
  ui.wander.textContent = '停止漫游';
  wanderFrame = requestAnimationFrame(wander);
});
window.addEventListener('keydown', (event) => {
  if (!acceptsPianoKeyboard(event)) return;
  activateAutomatically(true);
  if (event.code === 'KeyZ' || event.code === 'KeyX') {
    if (event.repeat) return;
    const direction = event.code === 'KeyZ' ? -12 : 12;
    keyboardRoot = Math.max(36, Math.min(84, keyboardRoot + direction));
    ui.midiStatus.textContent = `键盘 C${keyboardRoot / 12 - 1} · A–K 演奏 · Z/X 八度`;
    event.preventDefault();
    return;
  }
  const offset = COMPUTER_KEYS.get(event.code);
  if (offset === undefined || event.repeat) return;
  event.preventDefault();
  startPlayableNote(`key:${event.code}`, keyboardRoot + offset, 0.68, { kind: 'computer' });
});
window.addEventListener('keyup', (event) => {
  if (!COMPUTER_KEYS.has(event.code)) return;
  stopPlayableNote(`key:${event.code}`);
});
window.addEventListener('blur', () => releaseWhere((entry) => entry.kind === 'computer'));
window.addEventListener('beforeunload', () => { releasePlayableNotes(); voice.disconnect(); }, { once: true });
window.addEventListener('pointerdown', () => activateAutomatically(true), { once: true, capture: true });

manifest = await fetch('./models.json').then((response) => {
  if (!response.ok) throw new Error('model manifest unavailable');
  return response.json();
});
for (const entry of manifest.models) {
  const option = document.createElement('option');
  option.value = entry.id;
  option.textContent = entry.displayName;
  ui.model.appendChild(option);
}
await selectModel();
refreshWanderControls();
activateAutomatically(false);
