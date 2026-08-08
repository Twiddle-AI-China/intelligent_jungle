import { PolyphonicInputRouter } from './input-router.js';
import { MidiInputController } from './midi-input.js';
import { PolyphonicVoiceAllocator } from './voice-allocator.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  model: $('#model'), note: $('#note'), noteValue: $('#note-value'),
  knn: $('#knn'), knnValue: $('#knn-value'), connection: $('#connection'),
  cursor: $('#cursor'), meta: $('#model-meta'), canvas: $('#map'),
  connect: $('#connect'), hold: $('#hold'), release: $('#release'), wander: $('#wander'),
  enableMidi: $('#enable-midi'), midiInput: $('#midi-input'), midiStatus: $('#midi-status'),
};

const context = ui.canvas.getContext('2d');
const voice = window.FlockVoiceClient.create({ fallbackEnabled: false, poolSize: 16 });
let manifest;
let model;
let latentMap;
let cursor = { x: 0, y: 0 };
let dragging = false;
let wandering = false;
let wanderFrame = null;
let wanderStarted = 0;
let activeRows = [];
let connectPromise = null;
let midiAccess = null;
let keyboardRoot = 60;
let voiceSyncRevision = 0;
const inputRouter = new PolyphonicInputRouter();
const midiInputController = new MidiInputController(inputRouter, { normalizeMidi: clampPlayableNote });
const voiceAllocator = new PolyphonicVoiceAllocator();
const MANUAL_HOLD_ID = 'manual:hold';
const WANDER_PREVIEW_ID = 'wander:preview';
const COMPUTER_KEYS = new Map([
  ['KeyA', 0], ['KeyW', 1], ['KeyS', 2], ['KeyE', 3], ['KeyD', 4],
  ['KeyF', 5], ['KeyT', 6], ['KeyG', 7], ['KeyY', 8], ['KeyH', 9],
  ['KeyU', 10], ['KeyJ', 11], ['KeyK', 12],
]);

function clamp(value) { return Math.max(-1, Math.min(1, Number(value) || 0)); }
function rows() { return activeRows.length ? activeRows : [0]; }
function clampPlayableNote(midi) { return window.FlockVoiceClient.clampMidi(midi); }

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
function mapPoint(point) {
  const scale = Number(latentMap?.scale) || 1;
  return { x: clamp(point.x / scale), y: clamp(point.y / scale) };
}
function canvasPoint(value) {
  return [(value.x + 1) * ui.canvas.width / 2, (1 - value.y) * ui.canvas.height / 2];
}

function draw() {
  context.fillStyle = '#f0ead8';
  context.fillRect(0, 0, ui.canvas.width, ui.canvas.height);
  if (!latentMap) return;
  context.fillStyle = '#172537';
  for (const point of latentMap.points) {
    const [x, y] = canvasPoint(mapPoint(point));
    context.beginPath();
    context.arc(x, y, 2.6, 0, Math.PI * 2);
    context.fill();
  }
  const [x, y] = canvasPoint(cursor);
  context.strokeStyle = '#ff6846';
  context.lineWidth = 3;
  context.beginPath();
  context.arc(x, y, 12, 0, Math.PI * 2);
  context.stroke();
}

function sendCursor(next) {
  if (!latentMap || !model) return;
  cursor = { x: clamp(next.x), y: clamp(next.y) };
  const scale = Number(latentMap.scale) || 1;
  for (const targetRow of rows()) {
    voice.setParams(targetRow, {
      timbreXY: [cursor.x * scale, cursor.y * scale],
      timbreK: Number(ui.knn.value),
    });
  }
  ui.cursor.textContent = `X ${cursor.x.toFixed(3)}  Y ${cursor.y.toFixed(3)}  raw scale ${scale.toFixed(3)}`;
  draw();
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
    voice.setParams(targetRow, { timbre: model.compatibility.mockTimbre, timbreXY: null });
  }
  cursor = { x: 0, y: 0 };
  ui.meta.textContent = `${model.displayName} · ${model.engine} · 4-voice polyphony · ${latentMap.points.length} anchors · z${latentMap.dim}`;
  draw();
  requestVoiceSync();
}

function stopWander({ releasePreview = true } = {}) {
  wandering = false;
  ui.wander.setAttribute('aria-pressed', 'false');
  if (wanderFrame !== null) cancelAnimationFrame(wanderFrame);
  wanderFrame = null;
  if (releasePreview) stopPlayableNote(WANDER_PREVIEW_ID);
}

function wander(time) {
  if (!wandering) return;
  const phase = (time - wanderStarted) / 7000;
  sendCursor({ x: Math.sin(phase) * .78, y: Math.sin(phase * .63 + .8) * .72 });
  wanderFrame = requestAnimationFrame(wander);
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
  ui.midiStatus.textContent = inputs.length
    ? `MIDI enabled · ${inputs.length} input${inputs.length === 1 ? '' : 's'} · computer octave C${keyboardRoot / 12 - 1}`
    : `MIDI enabled · no input connected · computer octave C${keyboardRoot / 12 - 1}`;
}

function handleMidiMessage(event) {
  if (ui.midiInput.value !== 'all' && event.currentTarget.id !== ui.midiInput.value) return;
  if (midiInputController.handleMessage(event.currentTarget.id, event.data)) requestVoiceSync();
}

async function enableMidi() {
  await ensureConnected();
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is unavailable in this browser');
  midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  midiAccess.onstatechange = refreshMidiInputs;
  refreshMidiInputs();
  ui.enableMidi.textContent = 'MIDI enabled';
  ui.enableMidi.disabled = true;
}

voice.onStateChange((state) => {
  ui.connection.textContent = `${state.mode}${state.backend ? ` · ${state.backend}` : ''}${state.reason ? ` · ${state.reason}` : ''}`;
});

ui.canvas.addEventListener('pointerdown', (event) => {
  stopWander(); dragging = true; ui.canvas.setPointerCapture?.(event.pointerId); sendCursor(pointerCursor(event));
});
ui.canvas.addEventListener('pointermove', (event) => { if (dragging) sendCursor(pointerCursor(event)); });
ui.canvas.addEventListener('pointerup', () => { dragging = false; });
ui.canvas.addEventListener('pointercancel', () => { dragging = false; });
ui.note.addEventListener('input', () => {
  ui.noteValue.textContent = ui.note.value;
  if (inputRouter.has(MANUAL_HOLD_ID)) {
    startPlayableNote(MANUAL_HOLD_ID, Number(ui.note.value), 1, { kind: 'manual' });
  }
  if (inputRouter.has(WANDER_PREVIEW_ID)) {
    startPlayableNote(WANDER_PREVIEW_ID, Number(ui.note.value), 1, { kind: 'wander-preview' });
  }
});
ui.knn.addEventListener('input', () => { ui.knnValue.textContent = ui.knn.value; sendCursor(cursor); });
ui.model.addEventListener('change', () => selectModel().catch((error) => { ui.connection.textContent = error.message; }));
ui.connect.addEventListener('click', () => ensureConnected());
ui.enableMidi.addEventListener('click', () => enableMidi().catch((error) => { ui.midiStatus.textContent = error.message; }));
ui.midiInput.addEventListener('change', () => {
  if (midiInputController.releaseAll()) requestVoiceSync();
});
ui.hold.addEventListener('click', () => {
  startPlayableNote(MANUAL_HOLD_ID, Number(ui.note.value), 1, { kind: 'manual' });
});
ui.release.addEventListener('click', () => { stopWander({ releasePreview: false }); releasePlayableNotes(); });
ui.wander.addEventListener('click', () => {
  if (wandering) { stopWander(); return; }
  startPlayableNote(WANDER_PREVIEW_ID, Number(ui.note.value), 1, { kind: 'wander-preview' });
  wandering = true;
  wanderStarted = performance.now();
  ui.wander.setAttribute('aria-pressed', 'true');
  wanderFrame = requestAnimationFrame(wander);
});
window.addEventListener('keydown', (event) => {
  if (!acceptsPianoKeyboard(event)) return;
  if (event.code === 'KeyZ' || event.code === 'KeyX') {
    if (event.repeat) return;
    const direction = event.code === 'KeyZ' ? -12 : 12;
    keyboardRoot = Math.max(36, Math.min(84, keyboardRoot + direction));
    ui.midiStatus.textContent = `Computer octave C${keyboardRoot / 12 - 1} · A W S E D F T G Y H U J K`;
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
