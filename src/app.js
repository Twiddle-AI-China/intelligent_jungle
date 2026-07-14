import { createWorld, injectEnergy, setHarmonicCenter, setInteraction, stepWorld, TAU } from './world.js';
import { PerceptualWebAudioEngine } from './audio-engine.js';
import { SessionRecorder } from './session.js';

const MODES = [
  { id: 'gather', key: '1', name: '聚拢', symbol: '◎', description: '吸引附近对象结群，并进入共同音乐语境' },
  { id: 'scatter', key: '2', name: '推开', symbol: '↗', description: '让过近对象避让，也让冲突声部彼此让位' },
  { id: 'guide', key: '3', name: '引导', symbol: '→', description: '带动局部转向，让运动与音色趋势传向群体' },
  { id: 'disturb', key: '4', name: '扰动', symbol: '≋', description: '搅动局部方向与节奏，随后让群体自行恢复' },
  { id: 'energize', key: '5', name: '注入能量', symbol: '✦', description: '提高群体速度、声音密度与脉冲强度' },
];
const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const HARMONIES = [0, 2, 3, 5, 7, 9, 10];

const canvas = document.querySelector('#world');
const context = canvas.getContext('2d');
const world = createWorld();
const recorder = new SessionRecorder(world);
const audio = new PerceptualWebAudioEngine();
const behaviorStrip = document.querySelector('#behavior-strip');
const harmonyButtons = document.querySelector('#harmony-buttons');
const audioButton = document.querySelector('#audio-button');
const midiButton = document.querySelector('#midi-button');
const releaseButton = document.querySelector('#release-button');
const pointerLabel = document.querySelector('#pointer-label');
const modeTitle = document.querySelector('#mode-title');
const modeDescription = document.querySelector('#mode-description');
const harmonyOutput = document.querySelector('#harmony-output');
const status = document.querySelector('#status');
const meters = {
  context: document.querySelector('#context-meter'),
  trend: document.querySelector('#trend-meter'),
  clarity: document.querySelector('#clarity-meter'),
};
document.querySelector('#object-count').textContent = `${world.objects.length} OBJECTS`;

let mode = MODES[0];
let pointer = null;
let lastTime = performance.now();
let dpr = 1;

function selectMode(id) {
  mode = MODES.find((candidate) => candidate.id === id) ?? MODES[0];
  behaviorStrip.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode.id));
  modeTitle.textContent = mode.name;
  modeDescription.textContent = mode.description;
}

for (const item of MODES) {
  const button = document.createElement('button');
  button.dataset.mode = item.id;
  button.innerHTML = `<span>${item.symbol}</span><strong>${item.name}</strong><kbd>${item.key}</kbd>`;
  button.addEventListener('click', () => selectMode(item.id));
  behaviorStrip.append(button);
}
selectMode('gather');

for (const note of HARMONIES) {
  const button = document.createElement('button');
  button.textContent = NOTES[note];
  button.dataset.note = String(note);
  button.addEventListener('click', () => chooseHarmony(note));
  harmonyButtons.append(button);
}

function chooseHarmony(note) {
  setHarmonicCenter(world, note);
  if (world.time > 0) recorder.record(world, 'harmony', { note, velocity: 1 });
  harmonyOutput.textContent = `${NOTES[world.harmonicCenter]} · Dorian`;
  harmonyButtons.querySelectorAll('button').forEach((button) => button.classList.toggle('active', Number(button.dataset.note) === world.harmonicCenter));
}
chooseHarmony(0);

function resize() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  pointer = { ...point, previousX: point.x, previousY: point.y };
  setInteraction(world, { mode: mode.id, x: point.x, y: point.y, dx: 0, dy: 0, phase: world.time % 1, strength: 1 });
  recorder.record(world, 'interaction', world.interaction);
  pointerLabel.classList.add('visible');
  status.textContent = `正在${mode.name}声音群体`;
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return;
  const point = canvasPoint(event);
  pointer.previousX = pointer.x;
  pointer.previousY = pointer.y;
  pointer.x = point.x;
  pointer.y = point.y;
  const rect = canvas.getBoundingClientRect();
  pointerLabel.style.left = `${point.x * rect.width}px`;
  pointerLabel.style.top = `${point.y * rect.height}px`;
  const dx = (pointer.x - pointer.previousX) * 9;
  const dy = (pointer.y - pointer.previousY) * 9;
  setInteraction(world, { mode: mode.id, x: pointer.x, y: pointer.y, dx, dy, phase: world.time % 1, strength: 1 + Math.min(1.4, Math.hypot(dx, dy)) });
  recorder.record(world, 'interaction', world.interaction);
});

function release() {
  pointer = null;
  setInteraction(world, null);
  if (world.time > 0) recorder.record(world, 'release');
  pointerLabel.classList.remove('visible');
  status.textContent = audio.running ? '已释放 · 世界依靠惯性演化' : '世界正在静默运行';
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
releaseButton.addEventListener('click', release);

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    release();
    return;
  }
  const selected = MODES.find((item) => item.key === event.key);
  if (selected) selectMode(selected.id);
});

audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(world.objects);
  else await audio.toggle();
  audioButton.textContent = audio.running ? '暂停声音' : '继续声音';
  audioButton.classList.toggle('running', audio.running);
  status.textContent = audio.running ? `声音世界已唤醒 · ${audio.label}` : '声音已暂停，世界仍在运行';
});

midiButton.addEventListener('click', async () => {
  if (!navigator.requestMIDIAccess) {
    status.textContent = '当前浏览器不支持 Web MIDI';
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    for (const input of access.inputs.values()) {
      input.onmidimessage = ({ data }) => {
        const [command, note, velocity] = data;
        if ((command & 0xf0) === 0x90 && velocity > 0) {
          chooseHarmony(note % 12);
          injectEnergy(world, velocity / 127);
          recorder.record(world, 'energy', { amount: velocity / 127 });
          status.textContent = `MIDI 引力：${NOTES[note % 12]} · 能量 ${Math.round(velocity / 1.27)}%`;
        }
      };
    }
    midiButton.textContent = `${access.inputs.size} MIDI 已连接`;
  } catch {
    status.textContent = 'MIDI 授权未完成';
  }
});

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);

  const gradient = context.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.46, width * 0.58);
  gradient.addColorStop(0, 'rgba(35, 73, 64, .18)');
  gradient.addColorStop(1, 'rgba(2, 8, 8, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (let i = 0; i < world.objects.length; i += 1) {
    for (let j = i + 1; j < world.objects.length; j += 1) {
      const a = world.objects[i];
      const b = world.objects[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const neighborRadius = 0.42;
      if (distance > neighborRadius) continue;
      context.strokeStyle = `rgba(120, 201, 174, ${(1 - distance / neighborRadius) * 0.12})`;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(a.x * width, a.y * height);
      context.lineTo(b.x * width, b.y * height);
      context.stroke();
    }
  }

  for (const object of world.objects) {
    const x = object.x * width;
    const y = object.y * height;
    const radius = 5 + object.energy * 8 + object.pulse * 5;
    const speed = Math.hypot(object.vx, object.vy);
    if (speed > 1e-6) {
      const tail = 18 + object.energy * 28;
      const tx = x - object.vx / speed * tail;
      const ty = y - object.vy / speed * tail;
      const trail = context.createLinearGradient(tx, ty, x, y);
      trail.addColorStop(0, 'rgba(103, 217, 178, 0)');
      trail.addColorStop(1, `hsla(${150 + object.brightness * 65}, 72%, 70%, .42)`);
      context.strokeStyle = trail;
      context.lineWidth = 1.4 + object.energy * 1.8;
      context.beginPath();
      context.moveTo(tx, ty);
      context.lineTo(x, y);
      context.stroke();
    }
    context.strokeStyle = `hsla(${150 + object.brightness * 65}, 68%, 68%, .18)`;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(x, y, radius + 9 + object.pulse * 14, 0, TAU);
    context.stroke();
    const halo = context.createRadialGradient(x, y, 1, x, y, radius * 3.4);
    halo.addColorStop(0, `hsla(${148 + object.brightness * 74}, 76%, 76%, .9)`);
    halo.addColorStop(0.2, `hsla(${148 + object.brightness * 74}, 70%, 62%, .45)`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = halo;
    context.beginPath();
    context.arc(x, y, radius * 3.4, 0, TAU);
    context.fill();
    context.fillStyle = '#d9fff0';
    context.beginPath();
    context.arc(x, y, Math.max(2.2, radius * 0.3), 0, TAU);
    context.fill();
  }

  if (pointer) {
    const x = pointer.x * width;
    const y = pointer.y * height;
    context.strokeStyle = 'rgba(206, 255, 227, .7)';
    context.setLineDash([4, 8]);
    context.beginPath();
    context.arc(x, y, 30 + Math.sin(world.time * 6) * 4, 0, TAU);
    context.stroke();
    context.setLineDash([]);
  }
}

function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000);
  lastTime = time;
  stepWorld(world, dt);
  audio.update(world);
  draw();
  meters.context.value = world.metrics.context;
  meters.trend.value = world.metrics.trend;
  meters.clarity.value = world.metrics.clarity;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.latentCosmos = {
  exportSession: () => recorder.export(),
  world,
};
