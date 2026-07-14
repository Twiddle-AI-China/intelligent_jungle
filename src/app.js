import { addBoid, addFlock, addObstacle, createWorld, eraseAt, injectEnergy, setHarmonicCenter, setInteraction, SPECIES, stepWorld, TAU } from './world.js';
import { PerceptualWebAudioEngine } from './audio-engine.js';
import { SessionRecorder } from './session.js';

const TOOLS = [
  { id: 'add', key: '1', name: '加鸟', symbol: '+', description: '点击世界，为所选声音群增加一个行为粒子' },
  { id: 'obstacle', key: '2', name: '障碍', symbol: '◯', description: '放置障碍；鸟群绕行时声音产生转向压力' },
  { id: 'guide', key: '3', name: '引导', symbol: '→', description: '拖动局部鸟群，运动方向直接带动声音变化' },
  { id: 'erase', key: '4', name: '擦除', symbol: '×', description: '擦掉一只鸟或一个障碍，不会静默整个声音群' },
];
const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const HARMONIES = [0, 2, 3, 5, 7, 9, 10];
const canvas = document.querySelector('#world');
const context = canvas.getContext('2d');
const world = createWorld();
const recorder = new SessionRecorder(world);
const audio = new PerceptualWebAudioEngine();
const behaviorStrip = document.querySelector('#behavior-strip');
const speciesStrip = document.querySelector('#species-strip');
const harmonyButtons = document.querySelector('#harmony-buttons');
const audioButton = document.querySelector('#audio-button');
const engineFact = document.querySelector('#engine-fact');
const midiButton = document.querySelector('#midi-button');
const newFlockButton = document.querySelector('#new-flock-button');
const pointerLabel = document.querySelector('#pointer-label');
const modeTitle = document.querySelector('#mode-title');
const modeDescription = document.querySelector('#mode-description');
const harmonyOutput = document.querySelector('#harmony-output');
const status = document.querySelector('#status');
const objectCount = document.querySelector('#object-count');
const voiceAudit = document.querySelector('#voice-audit');
const meters = { context: document.querySelector('#context-meter'), trend: document.querySelector('#trend-meter'), clarity: document.querySelector('#clarity-meter') };
let tool = TOOLS[0];
let selectedSpecies = SPECIES[0].id;
let pointer = null;
let lastTime = performance.now();
let dpr = 1;
let lastVoiceAudit = 0;

function selectedFlock() { return world.objects.find((voice) => voice.speciesId === selectedSpecies)?.id ?? world.objects[0].id; }
function refreshCount() { objectCount.textContent = `${world.objects.length} VOICES · ${world.boids.length} BOIDS`; }
function refreshVoiceAudit() {
  const diagnostics = audio.getVoiceDiagnostics();
  if (!diagnostics.length) {
    if (voiceAudit.dataset.state !== 'idle') voiceAudit.innerHTML = '<span>启动声音后显示每个 Voice 的真实输出电平</span>';
    voiceAudit.dataset.state = 'idle';
    return;
  }
  if (voiceAudit.dataset.state !== `voices-${diagnostics.length}`) {
    voiceAudit.innerHTML = diagnostics.map((item) => {
      const voice = world.objects[item.index];
      const name = SPECIES.find((species) => species.id === voice?.speciesId)?.name ?? `Voice ${item.index + 1}`;
      return `<div class="voice-row" data-index="${item.index}"><i style="--voice:hsl(${voice?.hue ?? 160} 70% 70%)"></i><strong>V${item.index + 1} ${name}</strong><output>−∞</output><button data-action="mute">M</button><button data-action="solo">S</button></div>`;
    }).join('');
    voiceAudit.dataset.state = `voices-${diagnostics.length}`;
  }
  diagnostics.forEach((item) => {
    const row = voiceAudit.querySelector(`.voice-row[data-index="${item.index}"]`);
    if (!row) return;
    row.querySelector('output').textContent = item.db <= -100 ? '−∞' : `${item.db.toFixed(1)} dB`;
    row.querySelector('[data-action="mute"]').classList.toggle('active', item.muted);
    row.querySelector('[data-action="solo"]').classList.toggle('active', item.solo);
  });
}
voiceAudit.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const row = event.target.closest('.voice-row');
  if (!button || !row) return;
  const index = Number(row.dataset.index);
  const diagnostic = audio.getVoiceDiagnostics()[index];
  if (!diagnostic) return;
  if (button.dataset.action === 'mute') audio.setVoiceMuted(index, !diagnostic.muted);
  if (button.dataset.action === 'solo') audio.setVoiceSolo(index, !diagnostic.solo);
  refreshVoiceAudit();
});
function selectTool(id) {
  tool = TOOLS.find((candidate) => candidate.id === id) ?? TOOLS[0];
  behaviorStrip.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.mode === tool.id));
  modeTitle.textContent = tool.name; modeDescription.textContent = tool.description;
}
for (const item of TOOLS) {
  const button = document.createElement('button');
  button.dataset.mode = item.id; button.innerHTML = `<span>${item.symbol}</span><strong>${item.name}</strong><kbd>${item.key}</kbd>`;
  button.addEventListener('click', () => selectTool(item.id)); behaviorStrip.append(button);
}
for (const species of SPECIES) {
  const button = document.createElement('button');
  button.dataset.species = species.id; button.textContent = species.name;
  button.style.setProperty('--species', `hsl(${species.hue} 70% 70%)`);
  button.addEventListener('click', () => { selectedSpecies = species.id; speciesStrip.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button)); });
  speciesStrip.append(button);
}
speciesStrip.firstElementChild?.click(); selectTool('add'); refreshCount();
refreshVoiceAudit();

for (const note of HARMONIES) {
  const button = document.createElement('button'); button.textContent = NOTES[note]; button.dataset.note = String(note);
  button.addEventListener('click', () => chooseHarmony(note)); harmonyButtons.append(button);
}
function chooseHarmony(note) {
  setHarmonicCenter(world, note); recorder.record(world, 'harmony', { note, velocity: 1 });
  harmonyOutput.textContent = `${NOTES[world.harmonicCenter]} · Dorian`;
  harmonyButtons.querySelectorAll('button').forEach((button) => button.classList.toggle('active', Number(button.dataset.note) === world.harmonicCenter));
}
chooseHarmony(0);

newFlockButton.addEventListener('click', () => {
  const result = addFlock(world, selectedSpecies, 0.5, 0.5);
  if (result !== false) recorder.record(world, 'add-flock', { speciesId: selectedSpecies, x: 0.5, y: 0.5 });
  status.textContent = result === false ? '最多 6 个声音群；当前每群对应一对离线纹理，不是实时 decoder' : `新增 ${selectedSpecies} 声音群`;
  refreshCount();
});

function resize() { const rect = canvas.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); context.setTransform(dpr, 0, 0, dpr, 0, 0); }
window.addEventListener('resize', resize); resize();
function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId); const point = canvasPoint(event); pointer = { ...point, previousX: point.x, previousY: point.y };
  if (tool.id === 'add') { const flockId = selectedFlock(); if (addBoid(world, flockId, point.x, point.y)) recorder.record(world, 'add-boid', { flockId, x: point.x, y: point.y }); status.textContent = '已加鸟 · 这个声音群的密度与内部复杂度增加'; refreshCount(); }
  if (tool.id === 'obstacle') { addObstacle(world, point.x, point.y); recorder.record(world, 'add-obstacle', { x: point.x, y: point.y, radius: world.config.obstacleRadius }); status.textContent = '已放置障碍 · 鸟群绕行会改变转向压力'; }
  if (tool.id === 'erase') { const erased = eraseAt(world, point.x, point.y); if (erased) recorder.record(world, 'erase', { x: point.x, y: point.y, radius: 0.045 }); status.textContent = erased ? `已擦除${erased === 'boid' ? '一只鸟' : '一个障碍'}` : '这里没有可擦除对象'; refreshCount(); }
  if (tool.id === 'guide') setInteraction(world, { mode: 'guide', x: point.x, y: point.y, dx: 0, dy: 0, strength: 1 });
  pointerLabel.classList.add('visible');
});
canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return; const point = canvasPoint(event); const dx = (point.x - pointer.x) * 8; const dy = (point.y - pointer.y) * 8;
  pointer = { ...point, previousX: pointer.x, previousY: pointer.y };
  const rect = canvas.getBoundingClientRect(); pointerLabel.style.left = `${point.x * rect.width}px`; pointerLabel.style.top = `${point.y * rect.height}px`;
  if (tool.id === 'guide') setInteraction(world, { mode: 'guide', x: point.x, y: point.y, dx, dy, strength: 1 });
  if (tool.id === 'erase') eraseAt(world, point.x, point.y, 0.03);
});
function release() { pointer = null; setInteraction(world, null); pointerLabel.classList.remove('visible'); }
canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
window.addEventListener('keydown', (event) => { const selected = TOOLS.find((item) => item.key === event.key); if (selected) selectTool(selected.id); });

audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(world.objects); else await audio.toggle();
  const failed = audio.mode === 'audio-error';
  audioButton.textContent = failed ? '声音加载失败' : audio.running ? '暂停声音' : '继续声音';
  audioButton.classList.toggle('running', audio.running && !failed);
  engineFact.textContent = failed ? '声音链：素材失败，已静音' : '声音链：BRAVE 离线纹理 · 非实时 decoder · XY 非 latent 投影';
  status.textContent = failed ? audio.label : audio.running ? `声音世界已唤醒 · ${audio.label}` : '声音已暂停，鸟群仍在运行';
  refreshVoiceAudit();
});
midiButton.addEventListener('click', async () => {
  if (!navigator.requestMIDIAccess) { status.textContent = '当前浏览器不支持 Web MIDI'; return; }
  try {
    const access = await navigator.requestMIDIAccess();
    for (const input of access.inputs.values()) input.onmidimessage = ({ data }) => { const [command, note, velocity] = data; if ((command & 0xf0) === 0x90 && velocity > 0) { chooseHarmony(note % 12); injectEnergy(world, velocity / 127); } };
    midiButton.textContent = `${access.inputs.size} MIDI 已连接`;
  } catch { status.textContent = 'MIDI 授权未完成'; }
});

function draw() {
  const width = canvas.clientWidth; const height = canvas.clientHeight; context.clearRect(0, 0, width, height);
  const gradient = context.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.46, width * 0.58);
  gradient.addColorStop(0, 'rgba(35,73,64,.18)'); gradient.addColorStop(1, 'rgba(2,8,8,0)'); context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  for (const obstacle of world.obstacles) {
    context.fillStyle = 'rgba(5,12,10,.72)'; context.strokeStyle = 'rgba(255,178,116,.55)'; context.lineWidth = 1.5;
    context.beginPath(); context.arc(obstacle.x * width, obstacle.y * height, obstacle.radius * Math.min(width, height), 0, TAU); context.fill(); context.stroke();
  }
  for (const voice of world.objects) {
    const x = voice.centroid.x * width; const y = voice.centroid.y * height;
    context.strokeStyle = `hsla(${voice.hue},65%,68%,.15)`; context.beginPath(); context.arc(x, y, clampRadius(voice.spread * width), 0, TAU); context.stroke();
  }
  for (const boid of world.boids) {
    const voice = world.objects.find((candidate) => candidate.id === boid.flockId); const x = boid.x * width; const y = boid.y * height; const heading = Math.atan2(boid.vy, boid.vx);
    context.save(); context.translate(x, y); context.rotate(heading); context.fillStyle = `hsla(${voice?.hue ?? 160},72%,72%,.82)`;
    context.beginPath(); context.moveTo(7, 0); context.lineTo(-4, 3.4); context.lineTo(-2.5, 0); context.lineTo(-4, -3.4); context.closePath(); context.fill(); context.restore();
  }
}
function clampRadius(value) { return Math.max(18, Math.min(110, value)); }
function frame(time) { const dt = Math.min(0.05, (time - lastTime) / 1000); lastTime = time; stepWorld(world, dt); audio.update(world); draw(); meters.context.value = world.metrics.context; meters.trend.value = world.metrics.trend; meters.clarity.value = world.metrics.clarity; if (time - lastVoiceAudit > 250) { refreshVoiceAudit(); lastVoiceAudit = time; } requestAnimationFrame(frame); }
requestAnimationFrame(frame);
window.latentCosmos = { exportSession: () => recorder.export(), world, audio, addBoid, addObstacle, addFlock, eraseAt };
