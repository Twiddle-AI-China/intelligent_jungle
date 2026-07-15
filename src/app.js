import { DEFAULT_EFFECT_CONFIG, DEFAULT_FEATURE_CONFIG, XYLatentAudioEngine } from './audio-engine.js';
import { createEcosystem, setBoidsControl, setBoidsFeature, setGuideTarget, stepEcosystem } from './boids.js';
import { SessionRecorder } from './session.js';
import { createXYEngine, DEFAULT_ENGINE_CONFIG, noteOff, noteOn, setEngineControl, setXYTarget, stepXYEngine } from './xy-engine.js';

const KEYBOARD = [
  ['a', 60], ['w', 61], ['s', 62], ['e', 63], ['d', 64], ['f', 65], ['t', 66],
  ['g', 67], ['y', 68], ['h', 69], ['u', 70], ['j', 71], ['k', 72],
];
const CONTROL_SPECS = [
  { key: 'timbreRange', name: '探索范围', min: 0.25, max: 6, step: 0.05, unit: '×', target: 'engine' },
  { key: 'latentStep', name: '运动响应', min: 0.005, max: 0.5, step: 0.005, unit: '', target: 'engine' },
  { key: 'delayMix', name: '延迟空间', min: 0, max: 0.6, step: 0.01, unit: '', target: 'effect' },
  { key: 'reverbMix', name: '混响空间', min: 0, max: 0.6, step: 0.01, unit: '', target: 'effect' },
];
const BOIDS_SPECS = [
  { key: 'cohesion', name: '聚合', min: 0, max: 2.5, step: 0.05 },
  { key: 'alignment', name: '对齐', min: 0, max: 2.5, step: 0.05 },
  { key: 'separation', name: '分离', min: 0, max: 2.5, step: 0.05 },
  { key: 'maxSpeed', name: '速度', min: 0.04, max: 0.3, step: 0.005 },
  { key: 'space', name: '空间', min: 0.5, max: 2, step: 0.025 },
  { key: 'depth', name: '深度 Z', min: 0, max: 1, step: 0.025 },
];

const engine = createXYEngine();
const ecosystem = createEcosystem();
const audio = new XYLatentAudioEngine();
const recorder = new SessionRecorder(engine);
const canvas = document.querySelector('#xy-pad');
const context = canvas.getContext('2d');
const cursor = document.querySelector('#cursor');
const xyReadout = document.querySelector('#xy-readout');
const gateState = document.querySelector('#gate-state');
const status = document.querySelector('#status');
const audioButton = document.querySelector('#audio-button');
const midiButton = document.querySelector('#midi-button');
const modelSelect = document.querySelector('#model-select');
const parameterControls = document.querySelector('#parameter-controls');
let lastTime = performance.now();
let lastTrajectoryRecord = -Infinity;

function knobMarkup(spec, value, attribute) {
  const ratio = (value - spec.min) / (spec.max - spec.min); const angle = -135 + ratio * 270;
  return `<label class="knob"><span class="knob-name">${spec.name}</span><span class="knob-control"><input type="range" ${attribute} min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}" aria-label="${spec.name}"><span class="knob-dial" style="--angle:${angle}deg"><i></i></span></span><output class="knob-value">${value.toFixed(3)}${spec.unit ?? ''}</output></label>`;
}

function updateKnob(input, value, spec) {
  const ratio = (value - spec.min) / (spec.max - spec.min);
  input.nextElementSibling.style.setProperty('--angle', `${-135 + ratio * 270}deg`);
  input.closest('.knob').querySelector('output').textContent = `${value.toFixed(3)}${spec.unit ?? ''}`;
}

function renderControls() {
  parameterControls.innerHTML = CONTROL_SPECS.map((spec) => { const value = spec.target === 'effect' ? audio.effects[spec.key] : engine.config[spec.key]; return knobMarkup(spec, value, `data-control="${spec.key}" data-target="${spec.target}"`); }).join('');
}
parameterControls.addEventListener('input', (event) => {
  const input = event.target.closest('[data-control]');
  if (!input) return;
  const value = input.dataset.target === 'effect' ? audio.setEffectControl(input.dataset.control, input.value) : setEngineControl(engine, input.dataset.control, input.value);
  const spec = CONTROL_SPECS.find((item) => item.key === input.dataset.control);
  updateKnob(input, value, spec);
  recorder.record(engine, 'control', { key: input.dataset.control, value });
  audio.update(engine, true);
});
document.querySelector('#reset-parameters').addEventListener('click', () => {
  for (const [key, value] of Object.entries(DEFAULT_ENGINE_CONFIG)) setEngineControl(engine, key, value);
  for (const [key, value] of Object.entries(DEFAULT_EFFECT_CONFIG)) audio.setEffectControl(key, value);
  for (const [key, value] of Object.entries(DEFAULT_FEATURE_CONFIG)) audio.setFeatureToggle(key, value);
  setBoidsFeature(ecosystem, 'separationEnabled', true);
  document.querySelectorAll('[data-feature]').forEach((input) => { input.checked = input.dataset.feature === 'separationEnabled' ? ecosystem.config.separationEnabled : audio.features[input.dataset.feature]; });
  renderControls(); audio.update(engine, true);
});
renderControls();

const boidsControls = document.querySelector('#boids-controls');
boidsControls.innerHTML = BOIDS_SPECS.map((spec) => knobMarkup(spec, ecosystem.config[spec.key], `data-boids-control="${spec.key}"`)).join('');
boidsControls.addEventListener('input', (event) => {
  const input = event.target.closest('[data-boids-control]'); if (!input) return;
  const value = setBoidsControl(ecosystem, input.dataset.boidsControl, input.value);
  updateKnob(input, value, BOIDS_SPECS.find((item) => item.key === input.dataset.boidsControl));
});

const featureSwitches = document.querySelector('#feature-switches');
featureSwitches.addEventListener('change', (event) => {
  const input = event.target.closest('[data-feature]'); if (!input) return;
  if (input.dataset.feature === 'separationEnabled') setBoidsFeature(ecosystem, input.dataset.feature, input.checked);
  else audio.setFeatureToggle(input.dataset.feature, input.checked);
  if (input.dataset.feature === 'pitchShift') { refreshGate(); status.textContent = input.checked ? 'Pitch Shift 已开启' : 'Pitch Shift 已旁路：键盘只改变力度'; }
});

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize); resize();

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
}
function movePointer(event) {
  setGuideTarget(ecosystem, pointerPosition(event));
}
canvas.addEventListener('pointerdown', (event) => { canvas.setPointerCapture(event.pointerId); movePointer(event); });
canvas.addEventListener('pointermove', (event) => { if (canvas.hasPointerCapture(event.pointerId)) movePointer(event); });
function releasePointer() { setGuideTarget(ecosystem, null); }
canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer);

function refreshGate() {
  gateState.textContent = engine.heldNotes.size > 0 ? `${Math.min(3, engine.heldNotes.size)} VOICE${engine.heldNotes.size > 1 ? 'S' : ''} · latest MIDI ${engine.lastNote} · ${engine.pitchSemitones >= 0 ? '+' : ''}${engine.pitchSemitones} st` : 'ETERNAL DRONE · C4';
  document.querySelectorAll('[data-key]').forEach((key) => key.classList.toggle('active', engine.heldNotes.has(`key:${key.dataset.key}`)));
  audio.update(engine, true);
}
function startNote(id, note, velocity) { noteOn(engine, id, note, velocity); recorder.record(engine, 'note-on', { id, note, velocity }); refreshGate(); }
function endNote(id) { noteOff(engine, id); recorder.record(engine, 'note-off', { id }); refreshGate(); }

const keyStrip = document.querySelector('#key-strip');
for (const [key, note] of KEYBOARD) {
  const button = document.createElement('button'); button.dataset.key = key; button.textContent = key.toUpperCase(); button.title = `Gate ${note}`;
  button.addEventListener('pointerdown', () => startNote(`key:${key}`, note, 0.8));
  button.addEventListener('pointerup', () => endNote(`key:${key}`)); button.addEventListener('pointercancel', () => endNote(`key:${key}`));
  keyStrip.append(button);
}
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  const binding = KEYBOARD.find(([key]) => key === event.key.toLowerCase());
  if (binding) { event.preventDefault(); startNote(`key:${binding[0]}`, binding[1], 0.8); }
});
window.addEventListener('keyup', (event) => {
  const binding = KEYBOARD.find(([key]) => key === event.key.toLowerCase());
  if (binding) { event.preventDefault(); endNote(`key:${binding[0]}`); }
});

midiButton.addEventListener('click', async () => {
  if (!navigator.requestMIDIAccess) { status.textContent = '当前浏览器不支持 Web MIDI'; return; }
  try {
    const access = await navigator.requestMIDIAccess();
    for (const input of access.inputs.values()) input.onmidimessage = ({ data }) => {
      const [command, note, velocity] = data; const type = command & 0xf0; const channel = command & 0x0f; const id = `midi:${channel}:${note}`;
      if (type === 0x90 && velocity > 0) startNote(id, note, velocity / 127);
      if (type === 0x80 || (type === 0x90 && velocity === 0)) endNote(id);
    };
    midiButton.textContent = `${access.inputs.size} MIDI 已连接`;
  } catch { status.textContent = 'MIDI 授权未完成'; }
});

audio.discoverModels().then((models) => {
  modelSelect.innerHTML = models.map((model) => `<option value="${model.id}"${model.id === 'fsl10k-16d' ? ' selected' : ''}>${model.id} · ${model.latentSize}D</option>`).join('');
  audio.modelId = modelSelect.value || 'fsl10k-16d';
}).catch((error) => { status.textContent = `模型列表读取失败：${error.message}`; });
audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(engine); else await audio.toggle();
  audioButton.textContent = audio.mode === 'audio-error' ? '声音加载失败' : audio.running ? '暂停引擎' : '继续引擎';
  audioButton.classList.toggle('running', audio.running);
  status.textContent = audio.label;
});

function draw() {
  const width = canvas.clientWidth; const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(169,239,207,.10)'; context.lineWidth = 1;
  for (let i = 1; i < 8; i += 1) {
    context.beginPath(); context.moveTo(width * i / 8, 0); context.lineTo(width * i / 8, height); context.stroke();
    context.beginPath(); context.moveTo(0, height * i / 8); context.lineTo(width, height * i / 8); context.stroke();
  }
  if (ecosystem.target) {
    context.strokeStyle = 'rgba(255,190,130,.5)'; context.beginPath();
    context.arc(ecosystem.target.x * width, ecosystem.target.y * height, 12, 0, Math.PI * 2); context.stroke();
  }
  for (const bird of [...ecosystem.birds].sort((a, b) => a.z - b.z)) {
    const x = bird.x * width; const y = bird.y * height; const heading = Math.atan2(bird.vy, bird.vx);
    const depth = Math.max(0, Math.min(1, bird.z)); const scale = 0.55 + depth * 0.8; const alpha = 0.18 + depth * 0.75;
    context.save(); context.translate(x, y); context.rotate(heading); context.scale(scale, scale); context.fillStyle = `rgba(169,239,207,${alpha})`;
    context.beginPath(); context.moveTo(8, 0); context.lineTo(-5, 3.8); context.lineTo(-2.5, 0); context.lineTo(-5, -3.8); context.closePath(); context.fill(); context.restore();
  }
  context.strokeStyle = 'rgba(169,239,207,.36)'; context.beginPath();
  context.arc(ecosystem.centroid.x * width, ecosystem.centroid.y * height, 7, 0, Math.PI * 2); context.stroke();
  const rendered = [ecosystem.centroid.x, ecosystem.centroid.y];
  cursor.style.left = `${rendered[0] * 100}%`; cursor.style.top = `${rendered[1] * 100}%`;
  xyReadout.textContent = `${rendered[0].toFixed(3)} · ${rendered[1].toFixed(3)} · ${ecosystem.centroid.z.toFixed(3)}`;
}
function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000); lastTime = time;
  stepEcosystem(ecosystem, dt); setXYTarget(engine, ecosystem.centroid.x, ecosystem.centroid.y, true); engine.relationState = [...ecosystem.relationState]; stepXYEngine(engine, dt);
  if (engine.time - lastTrajectoryRecord >= 0.05) { recorder.record(engine, 'relations', { values: engine.relationState }); lastTrajectoryRecord = engine.time; }
  audio.update(engine); draw();
  const telemetry = audio.telemetry;
  document.querySelector('#engine-fact').textContent = audio.label;
  document.querySelector('#level-output').textContent = telemetry.db > -100 ? `${telemetry.db.toFixed(1)} dB` : '−∞ dB';
  document.querySelector('#envelope-output').textContent = (telemetry.envelope ?? 0).toFixed(3);
  document.querySelector('#polyphony-output').textContent = `${telemetry.polyphony ?? 0} / 3`;
  document.querySelector('#age-output').textContent = `${(telemetry.voiceAge ?? 0).toFixed(2)} s`;
  document.querySelector('#latent-output').textContent = (telemetry.latentRadius ?? 0).toFixed(3);
  document.querySelector('#atlas-output').textContent = `${telemetry.atlasNode ?? 0} · d${(telemetry.atlasDistance ?? 0).toFixed(2)}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.latentCosmos = { ecosystem, engine, audio, exportSession: () => recorder.export() };
