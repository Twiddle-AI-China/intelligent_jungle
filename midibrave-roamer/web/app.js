const $ = (selector) => document.querySelector(selector);
const ui = {
  model: $('#model'), note: $('#note'), noteValue: $('#note-value'),
  knn: $('#knn'), knnValue: $('#knn-value'), connection: $('#connection'),
  cursor: $('#cursor'), meta: $('#model-meta'), canvas: $('#map'),
  connect: $('#connect'), hold: $('#hold'), release: $('#release'), wander: $('#wander'),
};

const context = ui.canvas.getContext('2d');
const voice = window.FlockVoiceClient.create({ fallbackEnabled: true });
let manifest;
let model;
let latentMap;
let cursor = { x: 0, y: 0 };
let dragging = false;
let wandering = false;
let wanderFrame = null;
let wanderStarted = 0;
let activeRow = null;

function clamp(value) { return Math.max(-1, Math.min(1, Number(value) || 0)); }
function row() { return activeRow ?? 0; }
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
  voice.setParams(row(), {
    timbreXY: [cursor.x * scale, cursor.y * scale],
    timbreK: Number(ui.knn.value),
  });
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
  const nextRow = nextModel?.compatibility?.row ?? 0;
  const response = await fetch(`./models/maps/${nextModel.map}`);
  if (!response.ok) throw new Error(`map unavailable: ${nextModel.map}`);
  latentMap = await response.json();
  if (latentMap.voice !== nextModel.compatibility.backendVoice) throw new Error('model/map binding mismatch');
  if (activeRow !== null && activeRow !== nextRow) {
    voice.release(activeRow);
    stopWander();
  }
  model = nextModel;
  activeRow = nextRow;
  voice.setParams(row(), { timbre: model.compatibility.mockTimbre, timbreXY: null });
  cursor = { x: 0, y: 0 };
  ui.meta.textContent = `${model.displayName} · ${model.engine} · ${latentMap.points.length} anchors · z${latentMap.dim}`;
  draw();
}

function stopWander() {
  wandering = false;
  ui.wander.setAttribute('aria-pressed', 'false');
  if (wanderFrame !== null) cancelAnimationFrame(wanderFrame);
  wanderFrame = null;
}

function wander(time) {
  if (!wandering) return;
  const phase = (time - wanderStarted) / 7000;
  sendCursor({ x: Math.sin(phase) * .78, y: Math.sin(phase * .63 + .8) * .72 });
  wanderFrame = requestAnimationFrame(wander);
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
ui.note.addEventListener('input', () => { ui.noteValue.textContent = ui.note.value; });
ui.knn.addEventListener('input', () => { ui.knnValue.textContent = ui.knn.value; sendCursor(cursor); });
ui.model.addEventListener('change', () => selectModel().catch((error) => { ui.connection.textContent = error.message; }));
ui.connect.addEventListener('click', () => voice.connect(window.location.origin));
ui.hold.addEventListener('click', () => voice.hold(row(), Number(ui.note.value), 1));
ui.release.addEventListener('click', () => { voice.release(row()); stopWander(); });
ui.wander.addEventListener('click', () => {
  if (wandering) { stopWander(); return; }
  voice.hold(row(), Number(ui.note.value), 1);
  wandering = true;
  wanderStarted = performance.now();
  ui.wander.setAttribute('aria-pressed', 'true');
  wanderFrame = requestAnimationFrame(wander);
});
window.addEventListener('beforeunload', () => voice.disconnect(), { once: true });

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
