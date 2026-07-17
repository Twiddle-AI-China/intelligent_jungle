import { addBoid, addFlock, addObstacle, createWorld, DEFAULT_CONFIG, DORIAN_INTERVALS, eraseAt, injectEnergy, setFlockAnchors, setHarmonicCenter, setInteraction, setWorldControl, SPECIES, stepWorld, TAU } from './world.js';
import { anchorsForPattern, defaultPattern, moveNote, patternsEqual, performPattern, quantizeRecording, ROLE_BANDS, shiftPattern, yToMidiDrift } from './score.js';
import { AGENT, USER, agentMayControl, controllerOf, createControlState, diveIn, drainAgentCommands, inInstrument, queueAgentCommand, release, releaseMaster, returnToScore, takeover, takeoverMaster } from './control.js';
import { LiveInstrumentSession } from './instrument/live-session.js';
import { PerceptualWebAudioEngine } from './audio-engine.js';
import { SessionRecorder } from './session.js';

const TOOLS = [
  { id: 'add', key: '1', name: '加鸟', symbol: '+', description: '点击世界，为所选声音群增加一个行为粒子' },
  { id: 'obstacle', key: '2', name: '障碍', symbol: '◯', description: '放置障碍；绕行关系进入第 8 个音色维度' },
  { id: 'guide', key: '3', name: '引导', symbol: '→', description: '改变鸟群位置和关系：位置演奏音符，关系改变音色' },
  { id: 'erase', key: '4', name: '擦除', symbol: '×', description: '擦掉一只鸟或一个障碍，不会静默整个声音群' },
];
const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const HARMONIES = [0, 2, 3, 5, 7, 9, 10];
const CONTROL_SPECS = [
  { key: 'latentStep', name: '迁徙响应', min: 0.02, max: 0.8, step: 0.01, format: (value) => value.toFixed(2), hint: '目标追赶的每步上限', affects: '关系→音色响应' },
  { key: 'maxSpeed', name: '巡航速度', min: 0.04, max: 0.24, step: 0.005, format: (value) => value.toFixed(3), hint: '鸟的运动速度上限', affects: '能量 / 对齐 / 湍流' },
  { key: 'maxForce', name: '转向力度', min: 0.08, max: 0.8, step: 0.02, format: (value) => value.toFixed(2), hint: '改变方向的敏捷度', affects: '对齐 / 环流 / 障碍' },
  { key: 'neighborRadius', name: '感知半径', min: 0.08, max: 0.3, step: 0.005, format: (value) => value.toFixed(3), hint: '多远开始看见伙伴', affects: '紧密 / 对齐' },
  { key: 'separationRadius', name: '贴身距离', min: 0.025, max: 0.1, step: 0.005, format: (value) => value.toFixed(3), hint: '多近开始互相避让', affects: '紧密 / 扩张 / 群间' },
  { key: 'clusterRadius', name: '分群距离', min: 0.035, max: 0.2, step: 0.005, format: (value) => value.toFixed(3), hint: '近鸟合成一音', affects: '音符数量 / 时值' },
  { key: 'minNoteBirds', name: '最小成组', min: 1, max: 5, step: 1, format: (value) => `${Math.round(value)} 鸟`, hint: '过滤孤鸟音符', affects: '音符数量' },
  { key: 'cohesionStrength', name: '聚合', min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '靠近同群', affects: '紧密 / 扩张' },
  { key: 'alignmentStrength', name: '对齐', min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '共享趋势', affects: '对齐 / 湍流' },
  { key: 'separationStrength', name: '分离', min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '避免重叠', affects: '紧密 / 扩张 / 群间' },
  { key: 'wanderStrength', name: '游荡幅度', min: 0, max: 0.8, step: 0.02, format: (value) => value.toFixed(2), hint: '自主转向的空间力度', affects: '环流 / 湍流 / 能量' },
  { key: 'wanderRate', name: '游荡速度', min: 0.03, max: 0.5, step: 0.01, format: (value) => `${value.toFixed(2)} Hz`, hint: '自主转向变化有多快', affects: '环流 / 湍流' },
];
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
const parameterControls = document.querySelector('#parameter-controls');
const resetParameters = document.querySelector('#reset-parameters');
const meters = { context: document.querySelector('#context-meter'), trend: document.querySelector('#trend-meter'), clarity: document.querySelector('#clarity-meter') };
const masterBadge = document.querySelector('#master-badge');
const bpmSlider = document.querySelector('#bpm-slider');
const bpmOutput = document.querySelector('#bpm-output');
const chordQuality = document.querySelector('#chord-quality');
const masterRelease = document.querySelector('#master-release');
const instrumentHud = document.querySelector('#instrument-hud');
const instrumentName = document.querySelector('#instrument-name');
const recordCount = document.querySelector('#record-count');
const keepPhraseButton = document.querySelector('#keep-phrase');
const discardReturnButton = document.querySelector('#discard-return');
let tool = TOOLS[0];
let selectedSpecies = SPECIES[0].id;
let pointer = null;
let lastTime = performance.now();
let dpr = 1;
let lastVoiceAudit = 0;

// 接管状态机：谁握着缰绳（AGENT/USER）、现在看哪层（SCORE/INSTRUMENT）。
const controlState = createControlState();
const liveSessions = new Map();
let liveSession = null;
// 已接管群在乐谱层的拖拽：type = 'pattern'（整体平移）| 'note'（单音符）。
let anchorDrag = null;
const ROLE_NAMES = { bass: '低吟', support: '和鸣', ornament: '飞羽' };

// 乐谱层状态：server sequencer 持有真实时钟，这里只保存 anchor 与最近发送的 pattern。
const scoreState = {
  enabled: false,
  loopBeats: 16,
  chord: { rootMidi: 57, quality: 'minor' },
  anchors: new Map(),
  lastSent: new Map(),
  lastBeat: -1,
  lastBar: -1,
};
const wrappedDelta = (target, source) => ((target - source + 1.5) % 1) - 0.5;

function assignFlockPattern(voice) {
  const pattern = defaultPattern(voice.role, scoreState.chord, scoreState.loopBeats);
  const anchors = anchorsForPattern(pattern, scoreState.loopBeats);
  scoreState.anchors.set(voice.id, anchors);
  setFlockAnchors(world, voice.id, anchors);
  audio.setPattern(voice.id, pattern);
  scoreState.lastSent.set(voice.id, pattern);
}

function activateScore() {
  scoreState.enabled = true;
  world.config.anchorStiffness = 2.4;
  audio.setTransport({ bpm: world.tempo, beatsPerBar: 4, loopBars: 4, playing: true });
  audio.setChord(scoreState.chord.rootMidi, scoreState.chord.quality);
  for (const voice of world.objects) assignFlockPattern(voice);
}

function anchorDrifts(voice, anchors) {
  const birds = world.boids.filter((boid) => boid.flockId === voice.id);
  return anchors.map((anchor, index) => {
    const assigned = birds.filter((bird) => bird.id % anchors.length === index);
    if (!assigned.length) return { dx: 0, dy: 0 };
    return {
      dx: assigned.reduce((sum, bird) => sum + wrappedDelta(bird.x, anchor.x), 0) / assigned.length,
      dy: assigned.reduce((sum, bird) => sum + wrappedDelta(bird.y, anchor.y), 0) / assigned.length,
    };
  });
}

// 每圈开始时，把上一圈鸟群围绕 anchor 的实际漂移折算成 swing/借音并重发。
// bar 边界统一放行 agent 命令（结构变化节拍化）。
function syncScoreWithTransport() {
  if (!scoreState.enabled || !audio.transport) return;
  world.pulsePosition = audio.transport.beat / Math.max(1e-6, audio.transport.loopBeats);
  const bar = Math.floor(audio.transport.beat / Math.max(1, audio.transport.beatsPerBar ?? 4));
  if (bar !== scoreState.lastBar || audio.transport.beat < scoreState.lastBeat) {
    for (const command of drainAgentCommands(controlState)) executeAgentCommand(command);
  }
  if (audio.transport.beat < scoreState.lastBeat) {
    for (const voice of world.objects) {
      // 下潜中的群由 instrument 会话供音，拖拽中的群等 pointerup 落定，都不重发。
      if (inInstrument(controlState, voice.id) || anchorDrag?.flockId === voice.id) continue;
      const anchors = scoreState.anchors.get(voice.id);
      if (!anchors?.length) continue;
      const performed = performPattern(anchors, anchorDrifts(voice, anchors), scoreState.chord, scoreState.loopBeats);
      if (!patternsEqual(performed, scoreState.lastSent.get(voice.id))) {
        audio.setPattern(voice.id, performed);
        scoreState.lastSent.set(voice.id, performed);
      }
    }
  }
  scoreState.lastBar = bar;
  scoreState.lastBeat = audio.transport.beat;
}

// ——— Agent Control API（客户端命令面）———
// agent 服务通过 window.latentCosmos.applyAgentCommand 提交结构化命令；
// 命令排队到 bar 边界执行，用户接管的对象对 agent 静默（G7：无 agent 一切照常）。
function executeAgentCommand(command) {
  try {
    if (command.target === 'master') {
      if (command.op === 'setTempo' && Number.isFinite(command.bpm)) setMasterTempo(command.bpm, false);
      if (command.op === 'setChord') {
        if (Number.isFinite(command.rootMidi)) chooseHarmony(((command.rootMidi % 12) + 12) % 12, false);
        if (command.quality) setMasterChord(undefined, command.quality, false);
      }
      if (command.op === 'assignRole') assignVoiceRole(command.objectId, command.role);
    } else if (command.target === 'flock' && command.op === 'setPattern') {
      const voice = world.objects.find((candidate) => candidate.id === command.objectId);
      if (!voice || !Array.isArray(command.notes)) return;
      const band = ROLE_BANDS[voice.role] ?? ROLE_BANDS.support;
      const pattern = shiftPattern(command.notes, 0, 0, scoreState.chord, band, scoreState.loopBeats);
      commitPattern(voice, pattern);
    }
  } catch (error) {
    console.warn('agent command rejected', command, error);
  }
}

function applyAgentCommand(command) {
  if (!command || typeof command !== 'object') return false;
  const allowed = command.target === 'master'
    ? agentMayControl(controlState, 'master')
    : agentMayControl(controlState, 'flock', command.objectId);
  if (!allowed) return false;
  queueAgentCommand(controlState, command);
  return true;
}

function commitPattern(voice, pattern) {
  const anchors = anchorsForPattern(pattern, scoreState.loopBeats);
  scoreState.anchors.set(voice.id, anchors);
  setFlockAnchors(world, voice.id, anchors);
  audio.setPattern(voice.id, pattern);
  scoreState.lastSent.set(voice.id, pattern);
}

// ——— Master 最小集：生命节律（BPM）/ 和声（根音+性质）/ 音域分配 ———
// 同一套函数是用户 HUD 与 master agent 的共同控制面；byUser 才夺主脉缰绳。
function refreshMasterHud() {
  const userHeld = controlState.master === USER;
  masterBadge.textContent = userHeld ? '主脉 · 由你掌握' : '主脉 · 生态自持';
  masterBadge.classList.toggle('user', userHeld);
  masterRelease.hidden = !userHeld;
  bpmSlider.value = String(world.tempo);
  bpmOutput.textContent = String(Math.round(world.tempo));
  chordQuality.value = scoreState.chord.quality;
}

function setMasterTempo(bpm, byUser = true) {
  world.tempo = Math.max(56, Math.min(140, Math.round(bpm)));
  if (byUser) takeoverMaster(controlState);
  if (scoreState.enabled) audio.setTransport({ bpm: world.tempo, beatsPerBar: 4, loopBars: 4, playing: true });
  refreshMasterHud();
}

function setMasterChord(rootMidi, quality, byUser = true) {
  if (Number.isFinite(rootMidi)) scoreState.chord = { ...scoreState.chord, rootMidi: Math.round(rootMidi) };
  if (quality && quality in CHORD_QUALITY_NAMES) scoreState.chord = { ...scoreState.chord, quality };
  if (byUser) takeoverMaster(controlState);
  if (scoreState.enabled) audio.setChord(scoreState.chord.rootMidi, scoreState.chord.quality);
  for (const session of liveSessions.values()) session.setChord(scoreState.chord);
  harmonyOutput.textContent = `${NOTES[world.harmonicCenter]} · ${CHORD_QUALITY_NAMES[scoreState.chord.quality]}`;
  refreshMasterHud();
}

// 音域分配：换声部角色即换音域带；agent 掌控的群按新带重新生成乐句，
// 用户掌控的群把现有乐句整体量化进新带（不推翻用户的演奏）。
function assignVoiceRole(objectId, role) {
  const voice = world.objects.find((candidate) => candidate.id === objectId);
  if (!voice || !(role in ROLE_BANDS)) return false;
  voice.role = role;
  voice.pitchRegister = role === 'bass' ? -1 : role === 'ornament' ? 1 : 0;
  if (!scoreState.enabled) return true;
  if (controllerOf(controlState, voice.id) === USER) {
    const base = (scoreState.anchors.get(voice.id) ?? []).map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
    commitPattern(voice, shiftPattern(base, 0, 0, scoreState.chord, ROLE_BANDS[role], scoreState.loopBeats));
  } else {
    assignFlockPattern(voice);
  }
  return true;
}

const CHORD_QUALITY_NAMES = { minor: '幽暗（小三）', major: '明亮（大三）', minor7: '雾霭（小七）', major7: '晨光（大七）', sus2: '悬浮（sus2）', sus4: '张力（sus4）' };

bpmSlider.addEventListener('input', () => { setMasterTempo(Number(bpmSlider.value)); status.textContent = `生命节律 ${world.tempo}——主脉已由你掌握`; });
chordQuality.addEventListener('change', () => { setMasterChord(undefined, chordQuality.value); status.textContent = `和声色彩 → ${CHORD_QUALITY_NAMES[scoreState.chord.quality]}`; });
masterRelease.addEventListener('click', () => { releaseMaster(controlState); refreshMasterHud(); status.textContent = '主脉交还生态，以当前节律与和声为新基础'; });

function renderParameterControls() {
  parameterControls.innerHTML = CONTROL_SPECS.map((spec) => `<label class="parameter" title="${spec.hint} → ${spec.affects}"><span>${spec.name}<small>${spec.affects}</small></span><input type="range" data-control="${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${world.config[spec.key]}"><output>${spec.format(world.config[spec.key])}</output></label>`).join('');
}
parameterControls.addEventListener('input', (event) => {
  const input = event.target.closest('input[data-control]');
  if (!input) return;
  const spec = CONTROL_SPECS.find((item) => item.key === input.dataset.control);
  const value = setWorldControl(world, input.dataset.control, Number(input.value));
  input.closest('label').querySelector('output').textContent = spec.format(value);
  status.textContent = `${spec.name}：${spec.format(value)} · ${spec.hint} → ${spec.affects}`;
});
resetParameters.addEventListener('click', () => {
  for (const spec of CONTROL_SPECS) setWorldControl(world, spec.key, DEFAULT_CONFIG[spec.key]);
  renderParameterControls(); status.textContent = '空间规则与 Boids 参数已恢复默认';
});
renderParameterControls();

audio.discoverModels().then(() => { audio.assignDefaultDecoders(world); refreshVoiceAudit(); }).catch((error) => { status.textContent = `模型列表读取失败：${error.message}`; });

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
      const options = audio.models.map((model) => `<option value="${model.id}"${item.decoderId === model.id ? ' selected' : ''}>${model.id}</option>`).join('');
      const roleOptions = Object.keys(ROLE_BANDS).map((role) => `<option value="${role}"${voice?.role === role ? ' selected' : ''}>${ROLE_NAMES[role] ?? role}</option>`).join('');
      return `<div class="voice-row" data-index="${item.index}"><i style="--voice:hsl(${voice?.hue ?? 160} 70% 70%)"></i><strong>V${item.index + 1} ${name}</strong><em class="controller-badge">生态</em><select data-action="role" aria-label="Voice ${item.index + 1} 音域带">${roleOptions}</select><select data-action="decoder" aria-label="Voice ${item.index + 1} decoder">${options}</select><output>−∞</output><button data-action="mute">M</button><button data-action="solo">S</button><button data-action="take" class="take-button">接管</button></div>`;
    }).join('');
    voiceAudit.dataset.state = `voices-${diagnostics.length}`;
  }
  diagnostics.forEach((item) => {
    const row = voiceAudit.querySelector(`.voice-row[data-index="${item.index}"]`);
    if (!row) return;
    row.querySelector('output').textContent = item.db <= -100 ? '−∞' : `${item.db.toFixed(1)} dB`;
    const voice = world.objects[item.index];
    if (voice?.relationState) row.title = `8D 关系：${voice.relationState.map((value) => value.toFixed(2)).join(' · ')}`;
    row.querySelector('strong').textContent = `V${item.index + 1} ${SPECIES.find((species) => species.id === voice?.speciesId)?.name ?? 'Voice'} · ${item.noteGroups} NOTE${item.noteGroups > 1 ? 'S' : ''}`;
    row.querySelector('[data-action="mute"]').classList.toggle('active', item.muted);
    row.querySelector('[data-action="solo"]').classList.toggle('active', item.solo);
    row.querySelector('select[data-action="decoder"]').value = item.decoderId;
    if (voice) {
      const held = controllerOf(controlState, voice.id) === USER;
      const badge = row.querySelector('.controller-badge');
      badge.textContent = inInstrument(controlState, voice.id) ? '下潜' : held ? '由你' : '生态';
      badge.classList.toggle('user', held);
      const take = row.querySelector('[data-action="take"]');
      take.textContent = held ? '交还' : '接管';
      take.classList.toggle('active', held);
      const roleSelect = row.querySelector('select[data-action="role"]');
      if (roleSelect.value !== voice.role) roleSelect.value = voice.role;
    }
  });
}
voiceAudit.addEventListener('change', (event) => {
  const select = event.target.closest('select[data-action]');
  const row = event.target.closest('.voice-row');
  if (!select || !row) return;
  const index = Number(row.dataset.index);
  if (select.dataset.action === 'decoder' && audio.setVoiceDecoder(index, select.value)) {
    status.textContent = `Voice ${index + 1} → ${select.value}`;
  }
  if (select.dataset.action === 'role') {
    const voice = world.objects[index];
    if (voice && assignVoiceRole(voice.id, select.value)) status.textContent = `Voice ${index + 1} 迁入${ROLE_NAMES[select.value] ?? select.value}音域带`;
  }
});
voiceAudit.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const row = event.target.closest('.voice-row');
  if (!button || !row) return;
  const index = Number(row.dataset.index);
  const diagnostic = audio.getVoiceDiagnostics()[index];
  if (!diagnostic) return;
  if (button.dataset.action === 'mute') audio.setVoiceMuted(index, !diagnostic.muted);
  if (button.dataset.action === 'solo') audio.setVoiceSolo(index, !diagnostic.solo);
  if (button.dataset.action === 'take') {
    const voice = world.objects[index];
    if (voice) {
      if (controllerOf(controlState, voice.id) === USER) {
        release(controlState, voice.id);
        status.textContent = `${SPECIES.find((species) => species.id === voice.speciesId)?.name ?? 'Voice'} 交还生态，以当前乐句为新基础`;
      } else {
        takeover(controlState, voice.id);
        status.textContent = `已接管 ${SPECIES.find((species) => species.id === voice.speciesId)?.name ?? 'Voice'} · 拖动群体平移乐句，拖动光晕改单音`;
      }
    }
  }
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
  button.addEventListener('click', () => chooseHarmony(note, true)); harmonyButtons.append(button);
}
function chooseHarmony(note, byUser = false) {
  setHarmonicCenter(world, note); recorder.record(world, 'harmony', { note, velocity: 1 });
  // server 在触发时刻按当前和弦量化，pattern 不需要重发即可跟随和声变化。
  setMasterChord(48 + note, undefined, byUser);
  harmonyButtons.querySelectorAll('button').forEach((button) => button.classList.toggle('active', Number(button.dataset.note) === world.harmonicCenter));
}
chooseHarmony(0);

newFlockButton.addEventListener('click', () => {
  const result = addFlock(world, selectedSpecies, 0.5, 0.5);
  if (result !== false) {
    recorder.record(world, 'add-flock', { speciesId: selectedSpecies, x: 0.5, y: 0.5 });
    const voice = world.objects.find((candidate) => candidate.id === result);
    if (scoreState.enabled && voice) assignFlockPattern(voice);
  }
  status.textContent = result === false ? '最多 6 个声音群；每群对应一个可独立路由的 neural decoder Voice' : `新增 ${selectedSpecies} 声音群`;
  refreshCount();
});

function resize() { const rect = canvas.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); context.setTransform(dpr, 0, 0, dpr, 0, 0); }
window.addEventListener('resize', resize); resize();
function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }

// 已接管群的拖拽命中：先看单个 anchor 光晕（改单音），再看群体（整体平移）。
function hitTakenFlock(point) {
  for (const voice of world.objects) {
    if (controllerOf(controlState, voice.id) !== USER) continue;
    const anchors = scoreState.anchors.get(voice.id) ?? [];
    for (let index = 0; index < anchors.length; index += 1) {
      if (Math.hypot(wrappedDelta(point.x, anchors[index].x), point.y - anchors[index].y) < 0.03) return { voice, type: 'note', index };
    }
    if (Math.hypot(wrappedDelta(point.x, voice.centroid.x), point.y - voice.centroid.y) < Math.max(0.09, voice.spread * 1.6)) {
      return { voice, type: 'pattern', index: 0 };
    }
  }
  return null;
}

function commitAnchorDrag() {
  const drag = anchorDrag; anchorDrag = null;
  if (!drag || (Math.abs(drag.dx) < 1e-4 && Math.abs(drag.dy) < 1e-4)) return;
  const voice = world.objects.find((candidate) => candidate.id === drag.flockId);
  const base = (scoreState.anchors.get(drag.flockId) ?? []).map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
  if (!voice || !base.length) return;
  const band = ROLE_BANDS[voice.role] ?? ROLE_BANDS.support;
  const pattern = drag.type === 'pattern'
    ? shiftPattern(base, drag.dx * scoreState.loopBeats, yToMidiDrift(drag.dy), scoreState.chord, band, scoreState.loopBeats)
    : moveNote(base, drag.index, base[drag.index].beat + drag.dx * scoreState.loopBeats, base[drag.index].midi + yToMidiDrift(drag.dy), scoreState.chord, band, scoreState.loopBeats);
  commitPattern(voice, pattern);
  status.textContent = drag.type === 'pattern' ? `${voice.speciesName} 乐句整体平移 · 已在和弦内落位` : `${voice.speciesName} 单音已移动 · 和弦内量化`;
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId); const point = canvasPoint(event); pointer = { ...point, previousX: point.x, previousY: point.y };
  if (liveSession) { liveSession.guide(point.x, point.y, true); pointerLabel.classList.add('visible'); return; }
  const hit = hitTakenFlock(point);
  if (hit) {
    anchorDrag = { flockId: hit.voice.id, type: hit.type, index: hit.index, startX: point.x, startY: point.y, dx: 0, dy: 0 };
    pointerLabel.classList.add('visible');
    return;
  }
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
  if (liveSession) { liveSession.guide(point.x, point.y, true); return; }
  if (anchorDrag) { anchorDrag.dx = wrappedDelta(point.x, anchorDrag.startX); anchorDrag.dy = point.y - anchorDrag.startY; return; }
  if (tool.id === 'guide') setInteraction(world, { mode: 'guide', x: point.x, y: point.y, dx, dy, strength: 1 });
  if (tool.id === 'erase') eraseAt(world, point.x, point.y, 0.03);
});
function releasePointer() {
  pointer = null; setInteraction(world, null); pointerLabel.classList.remove('visible');
  if (liveSession) liveSession.guide(0, 0, false);
  if (anchorDrag) commitAnchorDrag();
}
canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer);

// 双击鸟群 → 下潜到声音引擎层（隐含接管）。
canvas.addEventListener('dblclick', (event) => {
  if (liveSession) return;
  const point = canvasPoint(event);
  let nearest = null; let nearestDistance = 0.16;
  for (const voice of world.objects) {
    const distance = Math.hypot(wrappedDelta(point.x, voice.centroid.x), point.y - voice.centroid.y);
    if (distance < nearestDistance) { nearest = voice; nearestDistance = distance; }
  }
  if (nearest) enterInstrument(nearest.id);
});

// ——— 下潜 / 返回（G4：全程共用同一 AudioContext 与 WebSocket，音频不断流）———
function enterInstrument(flockId) {
  const voice = world.objects.find((candidate) => candidate.id === flockId);
  if (!voice) return;
  diveIn(controlState, flockId);
  let session = liveSessions.get(flockId);
  if (!session) { session = new LiveInstrumentSession({ flockId, chord: scoreState.chord, loopBeats: scoreState.loopBeats }); liveSessions.set(flockId, session); }
  session.setChord(scoreState.chord);
  session.jamming = false;
  liveSession = session;
  audio.setVoiceOverride(flockId, session.controlOverride());
  instrumentHud.hidden = false;
  instrumentName.textContent = `下潜 · ${voice.speciesName}`;
  recordCount.textContent = '录音环 · 0 音';
  modeTitle.textContent = voice.speciesName; modeDescription.textContent = '群内相对运动塑造音色；键盘/MIDI 接管音高';
  status.textContent = `已下潜 ${voice.speciesName} · 上层其余声部照常循环`;
  refreshVoiceAudit();
}

function restoreFlockPattern(voice) {
  if (!voice) return;
  const pattern = scoreState.lastSent.get(voice.id);
  if (pattern) audio.setPattern(voice.id, pattern);
}

function exitInstrument(keepPhrase) {
  if (!liveSession) return;
  const voice = world.objects.find((candidate) => candidate.id === liveSession.flockId);
  if (keepPhrase) {
    const notes = liveSession.takeRecording(quantizeRecording);
    if (notes.length && voice) {
      commitPattern(voice, notes);
      status.textContent = `保留乐句 · ${notes.length} 音写回 ${voice.speciesName}，继续与其他声部合奏`;
    } else {
      restoreFlockPattern(voice);
      status.textContent = '录音环为空 · 原样返回编排层';
    }
  } else {
    liveSession.discardRecording();
    restoreFlockPattern(voice);
    status.textContent = '已返回编排层 · 演奏未写回';
  }
  liveSession.jamming = false;
  audio.setVoiceOverride(liveSession.flockId, null);
  liveSession = null;
  returnToScore(controlState);
  instrumentHud.hidden = true;
  selectTool(tool.id);
  refreshVoiceAudit();
}
keepPhraseButton.addEventListener('click', () => exitInstrument(true));
discardReturnButton.addEventListener('click', () => exitInstrument(false));

// 键盘演奏（下潜时）：A W S E D F T G Y H U J K → C4–C5。
const KEY_NOTES = { KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65, KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71, KeyK: 72 };
function transportBeat() { return audio.transport?.beat ?? NaN; }
function playLiveNote(key, midi, velocity, on) {
  if (!liveSession) return;
  if (on) {
    // 第一次按键才接管音高：无演奏时该群沿用上层 pattern 继续发声。
    if (!liveSession.jamming) { liveSession.jamming = true; audio.setPattern(liveSession.flockId, []); }
    liveSession.noteOn(key, midi, velocity, transportBeat());
  } else {
    liveSession.noteOff(key, transportBeat());
  }
  recordCount.textContent = `录音环 · ${liveSession.recording.length} 音`;
}
window.addEventListener('keydown', (event) => {
  if (liveSession) {
    if (event.code === 'Escape') { exitInstrument(false); return; }
    const midi = KEY_NOTES[event.code];
    if (midi !== undefined && !event.repeat) { playLiveNote(`kb-${event.code}`, midi, 0.85, true); event.preventDefault(); }
    return;
  }
  const selected = TOOLS.find((item) => item.key === event.key); if (selected) selectTool(selected.id);
});
window.addEventListener('keyup', (event) => {
  if (liveSession && KEY_NOTES[event.code] !== undefined) playLiveNote(`kb-${event.code}`, KEY_NOTES[event.code], 0.85, false);
});

audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(world.objects); else await audio.toggle();
  if (audio.running && !scoreState.enabled) activateScore();
  const failed = audio.mode === 'audio-error';
  audioButton.textContent = failed ? '声音加载失败' : audio.running ? '暂停声音' : '继续声音';
  audioButton.classList.toggle('running', audio.running && !failed);
  engineFact.textContent = failed ? '声音链：神经 decoder 失败，已静音' : '声音链：Boids → 逐 Voice decoder → ensemble mix';
  status.textContent = failed ? audio.label : audio.running ? `声音世界已唤醒 · ${audio.label}` : '声音已暂停，鸟群仍在运行';
  refreshVoiceAudit();
});
midiButton.addEventListener('click', async () => {
  if (!navigator.requestMIDIAccess) { status.textContent = '当前浏览器不支持 Web MIDI'; return; }
  try {
    const access = await navigator.requestMIDIAccess();
    for (const input of access.inputs.values()) input.onmidimessage = ({ data }) => {
      const [command, note, velocity] = data;
      const isOn = (command & 0xf0) === 0x90 && velocity > 0;
      const isOff = (command & 0xf0) === 0x80 || ((command & 0xf0) === 0x90 && velocity === 0);
      // 下潜时 MIDI 键盘接管该群音高；编排层时保持原有「换和声根音」语义。
      if (liveSession) {
        if (isOn) playLiveNote(`midi-${note}`, note, velocity / 127, true);
        else if (isOff) playLiveNote(`midi-${note}`, note, 0, false);
        return;
      }
      if (isOn) { chooseHarmony(note % 12, true); injectEnergy(world, velocity / 127); }
    };
    midiButton.textContent = `${access.inputs.size} MIDI 已连接`;
  } catch { status.textContent = 'MIDI 授权未完成'; }
});

function draw() {
  const width = canvas.clientWidth; const height = canvas.clientHeight; context.clearRect(0, 0, width, height);
  const gradient = context.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.46, width * 0.58);
  gradient.addColorStop(0, 'rgba(35,73,64,.18)'); gradient.addColorStop(1, 'rgba(2,8,8,0)'); context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  context.save();
  context.font = '10px ui-monospace, SFMono-Regular, monospace'; context.textBaseline = 'middle';
  for (let zone = 0; zone < DORIAN_INTERVALS.length; zone += 1) {
    const y = zone / DORIAN_INTERVALS.length * height;
    context.strokeStyle = 'rgba(130,190,174,.09)'; context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
    const note = NOTES[(world.harmonicCenter + DORIAN_INTERVALS[zone]) % 12];
    context.fillStyle = 'rgba(160,214,198,.42)'; context.fillText(note, 8, y + height / DORIAN_INTERVALS.length * 0.5);
  }
  const pulseX = world.pulsePosition * width;
  const pulseGradient = context.createLinearGradient(pulseX - 18, 0, pulseX + 18, 0);
  pulseGradient.addColorStop(0, 'rgba(255,178,116,0)'); pulseGradient.addColorStop(0.5, 'rgba(255,178,116,.52)'); pulseGradient.addColorStop(1, 'rgba(255,178,116,0)');
  context.fillStyle = pulseGradient; context.fillRect(pulseX - 18, 0, 36, height);
  context.fillStyle = 'rgba(255,190,130,.72)'; context.fillText('PULSE', Math.min(width - 42, pulseX + 5), 12);
  context.restore();
  // Pattern anchor 用光晕暗示（有机世界感，不画生硬网格）；拖拽中画预览位置。
  for (const voice of world.objects) {
    const anchors = scoreState.anchors.get(voice.id);
    if (!anchors?.length || !scoreState.enabled) continue;
    const dragging = anchorDrag?.flockId === voice.id ? anchorDrag : null;
    anchors.forEach((anchor, index) => {
      const shifted = dragging && (dragging.type === 'pattern' || dragging.index === index);
      const x = (((anchor.x + (shifted ? dragging.dx : 0)) % 1 + 1) % 1) * width;
      const y = Math.max(0, Math.min(1, anchor.y + (shifted ? dragging.dy : 0))) * height;
      const alpha = shifted ? 0.5 : 0.28;
      const glow = context.createRadialGradient(x, y, 0, x, y, 14);
      glow.addColorStop(0, `hsla(${voice.hue},70%,72%,${alpha})`); glow.addColorStop(1, `hsla(${voice.hue},70%,72%,0)`);
      context.fillStyle = glow; context.fillRect(x - 14, y - 14, 28, 28);
    });
  }
  // 每群头顶常驻小徽标：高亮 = 用户掌控（G3 状态可见性）。
  for (const voice of world.objects) {
    const held = controllerOf(controlState, voice.id) === USER;
    const x = voice.centroid.x * width; const y = voice.centroid.y * height - 20;
    context.beginPath(); context.arc(x, y, 3.2, 0, TAU);
    if (held) { context.fillStyle = 'rgba(169,239,207,.92)'; context.fill(); }
    else { context.strokeStyle = `hsla(${voice.hue},60%,70%,.4)`; context.lineWidth = 1; context.stroke(); }
  }
  for (const obstacle of world.obstacles) {
    context.fillStyle = 'rgba(5,12,10,.72)'; context.strokeStyle = 'rgba(255,178,116,.55)'; context.lineWidth = 1.5;
    context.beginPath(); context.arc(obstacle.x * width, obstacle.y * height, obstacle.radius * Math.min(width, height), 0, TAU); context.fill(); context.stroke();
  }
  context.save(); context.font = '9px ui-monospace, SFMono-Regular, monospace'; context.textBaseline = 'bottom';
  for (const voice of world.objects) for (const group of voice.noteGroups) {
    const x = group.x * width; const y = group.y * height;
    context.strokeStyle = `hsla(${voice.hue},72%,72%,.35)`; context.beginPath(); context.moveTo(x - 8, y - 9); context.lineTo(x + 8, y - 9); context.stroke();
    context.fillStyle = `hsla(${voice.hue},72%,80%,.72)`; context.fillText(`${NOTES[group.pitchClass]} ${Math.round(group.durationSeconds * 1000)}ms`, x + 11, y - 5);
  }
  context.restore();
  for (const boid of world.boids) {
    const voice = world.objects.find((candidate) => candidate.id === boid.flockId); const x = boid.x * width; const y = boid.y * height; const heading = Math.atan2(boid.vy, boid.vx);
    context.save(); context.translate(x, y); context.rotate(heading); context.fillStyle = `hsla(${voice?.hue ?? 160},72%,72%,.82)`;
    context.beginPath(); context.moveTo(7, 0); context.lineTo(-4, 3.4); context.lineTo(-2.5, 0); context.lineTo(-4, -3.4); context.closePath(); context.fill(); context.restore();
  }
}
// 下潜层渲染：单群全屏漫游 + 角落小型扫描环维持上层节拍感。
function drawInstrument() {
  const width = canvas.clientWidth; const height = canvas.clientHeight; context.clearRect(0, 0, width, height);
  const voice = world.objects.find((candidate) => candidate.id === liveSession.flockId);
  const hue = voice?.hue ?? 160;
  const backdrop = context.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, width * 0.6);
  backdrop.addColorStop(0, `hsla(${hue},45%,16%,.5)`); backdrop.addColorStop(1, 'rgba(2,8,8,0)');
  context.fillStyle = backdrop; context.fillRect(0, 0, width, height);
  const ecosystem = liveSession.ecosystem;
  for (const bird of ecosystem.birds) {
    const depth = (bird.z - 0.5) / 0.9 + 0.5;
    const radius = 1.6 + depth * 3.2;
    context.beginPath(); context.arc(bird.x * width, bird.y * height, radius, 0, TAU);
    context.fillStyle = `hsla(${hue},72%,${58 + depth * 20}%,${0.35 + depth * 0.45})`;
    context.fill();
  }
  if (ecosystem.target) {
    const x = ecosystem.target.x * width; const y = ecosystem.target.y * height;
    context.beginPath(); context.arc(x, y, 12, 0, TAU); context.strokeStyle = 'rgba(169,239,207,.5)'; context.lineWidth = 1; context.stroke();
  }
  // 小型扫描环：上层循环相位。
  if (audio.transport) {
    const phase = audio.transport.beat / Math.max(1e-6, audio.transport.loopBeats);
    const cx = width - 52; const cy = 52;
    context.beginPath(); context.arc(cx, cy, 20, 0, TAU); context.strokeStyle = 'rgba(130,190,174,.2)'; context.lineWidth = 2; context.stroke();
    context.beginPath(); context.arc(cx, cy, 20, -Math.PI / 2, -Math.PI / 2 + phase * TAU); context.strokeStyle = 'rgba(255,178,116,.7)'; context.stroke();
  }
  // 按住的音：底部音名行。
  const held = Array.from(liveSession.held.values(), (entry) => NOTES[((entry.midi % 12) + 12) % 12]).join(' ');
  if (held) {
    context.font = '18px ui-monospace, SFMono-Regular, monospace'; context.fillStyle = 'rgba(169,239,207,.8)';
    context.fillText(held, 32, height - 88);
  }
}

function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000); lastTime = time;
  stepWorld(world, dt); syncScoreWithTransport();
  if (liveSession) {
    liveSession.step(dt);
    audio.setVoiceOverride(liveSession.flockId, liveSession.controlOverride());
  }
  audio.update(world);
  if (liveSession) drawInstrument(); else draw();
  meters.context.value = world.metrics.context; meters.trend.value = world.metrics.trend; meters.clarity.value = world.metrics.clarity;
  if (time - lastVoiceAudit > 250) { refreshVoiceAudit(); lastVoiceAudit = time; }
  requestAnimationFrame(frame);
}
refreshMasterHud();
requestAnimationFrame(frame);
window.latentCosmos = { exportSession: () => recorder.export(), world, audio, addBoid, addObstacle, addFlock, eraseAt, applyAgentCommand, controlState };
