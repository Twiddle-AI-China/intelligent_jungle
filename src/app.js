import { addBoid, addFlock, addObstacle, createWorld, DEFAULT_CONFIG, DORIAN_INTERVALS, eraseAt, injectEnergy, setFlockAnchors, setHarmonicCenter, setInteraction, setWorldControl, SPECIES, stepWorld, TAU } from './world.js';
import { anchorsForPattern, bandForChord, defaultPattern, moveNote, patternsEqual, performPattern, quantizeRecording, quantizeToChord, ROLE_BANDS, shiftPattern, yToMidiDrift } from './score.js';
import { AGENT, USER, agentMayControl, controllerOf, createControlState, diveIn, drainAgentCommands, inInstrument, queueAgentCommand, release, releaseMaster, returnToScore, takeover, takeoverMaster } from './control.js';
import { LiveInstrumentSession } from './instrument/live-session.js';
import { PerceptualWebAudioEngine } from './audio-engine.js';
import { SessionRecorder } from './session.js';

const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const HARMONIES = [0, 2, 3, 5, 7, 9, 10];
// 下潜层的六个运动控制（PRD §3.2：运动 → 音色）。
const INSTRUMENT_CONTROL_SPECS = [
  { key: 'cohesion', name: '聚合', min: 0, max: 2.5, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '向心聚拢的意愿' },
  { key: 'alignment', name: '对齐', min: 0, max: 2.5, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '共享航向的意愿' },
  { key: 'separation', name: '分离', min: 0, max: 2.5, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '彼此避让的力度' },
  { key: 'maxSpeed', name: '速度', min: 0.04, max: 0.3, step: 0.005, format: (value) => value.toFixed(3), hint: '飞行速度上限' },
  { key: 'space', name: '空间', min: 0.5, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)}×`, hint: '感知距离的缩放' },
  { key: 'depth', name: '深度', min: 0, max: 1, step: 0.02, format: (value) => value.toFixed(2), hint: '纵向游弋的幅度' },
];
const canvas = document.querySelector('#world');
const context = canvas.getContext('2d');
const world = createWorld();
const recorder = new SessionRecorder(world);
const audio = new PerceptualWebAudioEngine();
const audioButton = document.querySelector('#audio-button');
const engineFact = document.querySelector('#engine-fact');
const midiButton = document.querySelector('#midi-button');
const pointerLabel = document.querySelector('#pointer-label');
const modeKicker = document.querySelector('#mode-kicker');
const modeTitle = document.querySelector('#mode-title');
const modeDescription = document.querySelector('#mode-description');
const status = document.querySelector('#status');
const voiceAudit = document.querySelector('#voice-audit');
const masterBadge = document.querySelector('#master-badge');
const bpmSlider = document.querySelector('#bpm-slider');
const bpmOutput = document.querySelector('#bpm-output');
const chordQuality = document.querySelector('#chord-quality');
const meterSelect = document.querySelector('#meter-select');
const loopBarsSelect = document.querySelector('#loop-bars-select');
const masterRelease = document.querySelector('#master-release');
const scoreView = document.querySelector('#score-view');
const instrumentView = document.querySelector('#instrument-view');
const instrumentCanvas = document.querySelector('#instrument-canvas');
const instrumentContext = instrumentCanvas.getContext('2d');
const instrumentName = document.querySelector('#instrument-name');
const recordCount = document.querySelector('#record-count');
const keepPhraseButton = document.querySelector('#keep-phrase');
const discardReturnButton = document.querySelector('#discard-return');
const instrumentParams = document.querySelector('#instrument-params');
const keyMap = document.querySelector('#key-map');
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
  beatsPerBar: 4,
  loopBars: 4,
  loopBeats: 16,
  chord: { rootMidi: 57, quality: 'minor' },
  anchors: new Map(),
  lastSent: new Map(),
  timbreBases: new Map(),
  lastBeat: -1,
  lastBar: -1,
  absoluteBar: 0,
};
audio.timbreBases = scoreState.timbreBases;
const wrappedDelta = (target, source) => ((target - source + 1.5) % 1) - 0.5;

// 粒子动画池：扫描线扫过 anchor 时触发。
const particles = [];
function spawnParticles(x, y, hue, count = 12) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * TAU;
    const speed = 0.02 + Math.random() * 0.05;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      hue,
    });
  }
}
function stepParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.life -= dt * 1.8;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function assignFlockPattern(voice) {
  const pattern = defaultPattern(voice.role, scoreState.chord, scoreState.loopBeats);
  const anchors = anchorsForPattern(pattern, scoreState.loopBeats);
  scoreState.anchors.set(voice.id, anchors);
  setFlockAnchors(world, voice.id, anchors);
  audio.setPattern(voice.id, pattern);
  scoreState.lastSent.set(voice.id, pattern);
}

function pushTransport() {
  if (scoreState.enabled) audio.setTransport({ bpm: world.tempo, beatsPerBar: scoreState.beatsPerBar, loopBars: scoreState.loopBars, playing: true });
}

function activateScore() {
  scoreState.enabled = true;
  world.config.anchorStiffness = 4.0;
  world.config.anchoredSpeedScale = 0.15;
  world.config.anchoredWanderScale = 0.1;
  pushTransport();
  audio.setChord(scoreState.chord.rootMidi, scoreState.chord.quality);
  for (const voice of world.objects) assignFlockPattern(voice);
}

// 优化：一次遍历按 flockId 分桶，避免 anchors × birds 的 O(n×m) filter。
function anchorDrifts(voice, anchors) {
  const birdsByAnchor = Array.from({ length: anchors.length }, () => []);
  for (const boid of world.boids) {
    if (boid.flockId !== voice.id) continue;
    birdsByAnchor[boid.id % anchors.length].push(boid);
  }
  return anchors.map((anchor, index) => {
    const assigned = birdsByAnchor[index];
    if (!assigned.length) return { dx: 0, dy: 0 };
    let dx = 0; let dy = 0;
    for (const bird of assigned) {
      dx += wrappedDelta(bird.x, anchor.x);
      dy += wrappedDelta(bird.y, anchor.y);
    }
    return { dx: dx / assigned.length, dy: dy / assigned.length };
  });
}

function syncScoreWithTransport() {
  if (!scoreState.enabled || !audio.transport) return;
  world.pulsePosition = audio.transport.beat / Math.max(1e-6, audio.transport.loopBeats);
  const bar = Math.floor(audio.transport.beat / Math.max(1, audio.transport.beatsPerBar ?? 4));
  if (bar !== scoreState.lastBar || audio.transport.beat < scoreState.lastBeat) {
    if (scoreState.lastBar >= 0) scoreState.absoluteBar += 1;
    for (const command of drainAgentCommands(controlState, scoreState.absoluteBar)) executeAgentCommand(command);
  }
  if (audio.transport.beat < scoreState.lastBeat) {
    for (const voice of world.objects) {
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

// ——— Agent Control API（架构 §2.5）———
function executeAgentCommand(command) {
  try {
    if (command.target === 'master') {
      if (command.op === 'setTempo' && Number.isFinite(command.bpm)) setMasterTempo(command.bpm, false);
      if (command.op === 'setChord') {
        if (Number.isFinite(command.rootMidi)) chooseHarmony(((command.rootMidi % 12) + 12) % 12, false);
        if (command.quality) setMasterChord(undefined, command.quality, false);
      }
      if (command.op === 'assignRole') assignVoiceRole(command.objectId, command.role);
      if (command.op === 'setSection') console.log(`[agent] set_section ${command.name ?? 'unnamed'} · ${command.bars ?? '?'} bars`);
    } else if (command.target === 'flock') {
      const voice = world.objects.find((candidate) => candidate.id === command.objectId);
      if (!voice) return;
      if (command.op === 'setPattern') {
        if (!Array.isArray(command.notes)) return;
        const band = bandForChord(scoreState.chord, voice.role);
        const pattern = shiftPattern(command.notes, 0, 0, scoreState.chord, band, scoreState.loopBeats);
        commitPattern(voice, pattern);
      }
      if (command.op === 'setAnchor') setVoiceAnchor(voice, command.x, command.y);
      if (command.op === 'setDensity') setVoiceDensity(voice, command.value);
      if (command.op === 'setRegister') setVoiceRegister(voice, command.loMidi, command.hiMidi);
      if (command.op === 'setMotion') setVoiceMotion(command.wander, command.spread);
    }
  } catch (error) {
    console.warn('agent command rejected', command, error);
  }
}

function setVoiceAnchor(voice, x, y) {
  const anchors = scoreState.anchors.get(voice.id) ?? [];
  if (!anchors.length) return;
  const band = bandForChord(scoreState.chord, voice.role);
  const targetBeat = ((x % 1) + 1) % 1 * scoreState.loopBeats;
  const targetMidi = quantizeToChord(band.loMidi + (1 - y) * (band.hiMidi - band.loMidi), scoreState.chord);
  const currentBeats = anchors.map((a) => a.beat);
  const currentMidis = anchors.map((a) => a.midi);
  const beatOffset = targetBeat - currentBeats[0];
  const semitoneOffset = targetMidi - currentMidis[0];
  const base = anchors.map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
  commitPattern(voice, shiftPattern(base, beatOffset, semitoneOffset, scoreState.chord, band, scoreState.loopBeats));
}

function setVoiceDensity(voice, value) {
  const anchors = scoreState.anchors.get(voice.id) ?? [];
  if (!anchors.length || !Number.isFinite(value)) return;
  const keep = Math.max(1, Math.round(anchors.length * Math.max(0, Math.min(1, value))));
  const base = anchors.map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
  // 反复移除 beat 网格上最拥挤（前后间距和最小）的音。
  while (base.length > keep) {
    let tightest = 0; let tightestGap = Infinity;
    for (let i = 0; i < base.length; i += 1) {
      const prev = base[(i - 1 + base.length) % base.length];
      const next = base[(i + 1) % base.length];
      const gap = (next.beat - prev.beat + scoreState.loopBeats) % scoreState.loopBeats;
      if (gap < tightestGap) { tightest = i; tightestGap = gap; }
    }
    base.splice(tightest, 1);
  }
  commitPattern(voice, base);
}

function setVoiceRegister(voice, loMidi, hiMidi) {
  const anchors = scoreState.anchors.get(voice.id) ?? [];
  if (!anchors.length || !Number.isFinite(loMidi) || !Number.isFinite(hiMidi)) return;
  const base = anchors.map(({ beat, midi, durBeats, vel }) => ({
    beat, midi: Math.max(loMidi, Math.min(hiMidi, quantizeToChord(midi, scoreState.chord))), durBeats, vel,
  }));
  commitPattern(voice, base);
}

function setVoiceMotion(wander, spread) {
  if (Number.isFinite(wander)) world.config.wanderStrength = Math.max(0, Math.min(0.8, wander));
  if (Number.isFinite(spread)) world.config.anchoredWanderScale = Math.max(0, Math.min(1, spread));
}

function applyAgentCommand(command) {
  if (!command || typeof command !== 'object') return false;
  // 架构 §2.5 冻结契约：{flock?, at_bar?, cmds:[{type, ...}, ...]}
  if (Array.isArray(command.cmds)) {
    const atBar = Number.isFinite(command.at_bar) ? { atBar: command.at_bar } : {};
    const voiceTarget = Number.isFinite(command.flock) ? { target: 'flock', objectId: command.flock } : { target: 'master' };
    for (const cmd of command.cmds) {
      const expanded = { ...voiceTarget, ...atBar };
      switch (cmd.type) {
        case 'set_anchor':
          if (voiceTarget.target === 'flock' && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) Object.assign(expanded, { op: 'setAnchor', x: cmd.x, y: cmd.y });
          break;
        case 'set_density':
          if (voiceTarget.target === 'flock' && Number.isFinite(cmd.value)) Object.assign(expanded, { op: 'setDensity', value: cmd.value });
          break;
        case 'set_register':
          if (voiceTarget.target === 'flock' && Number.isFinite(cmd.lo) && Number.isFinite(cmd.hi)) Object.assign(expanded, { op: 'setRegister', loMidi: cmd.lo, hiMidi: cmd.hi });
          break;
        case 'set_motion':
          if (voiceTarget.target === 'flock') Object.assign(expanded, { op: 'setMotion', wander: cmd.wander, spread: cmd.spread });
          break;
        case 'set_bpm':
          if (Number.isFinite(cmd.value)) Object.assign(expanded, { target: 'master', op: 'setTempo', bpm: cmd.value });
          break;
        case 'set_scale': {
          const NOTE_MAP = { C: 0, 'C♯': 1, 'D♭': 1, D: 2, 'D♯': 3, 'E♭': 3, E: 4, F: 5, 'F♯': 6, 'G♭': 6, G: 7, 'G♯': 8, 'A♭': 8, A: 9, 'A♯': 10, 'B♭': 10, B: 11 };
          const pc = NOTE_MAP[String(cmd.root ?? '').trim()] ?? NOTE_MAP[String(cmd.root ?? '').trim().toUpperCase()];
          if (pc !== undefined) Object.assign(expanded, { target: 'master', op: 'setChord', rootMidi: 48 + pc, quality: cmd.mode === 'dorian' ? 'minor' : cmd.mode });
          break;
        }
        case 'set_band':
          if (Number.isFinite(cmd.flock) && Number.isFinite(cmd.lo) && Number.isFinite(cmd.hi)) Object.assign(expanded, { target: 'flock', objectId: cmd.flock, op: 'setRegister', loMidi: cmd.lo, hiMidi: cmd.hi });
          break;
        case 'set_section':
          Object.assign(expanded, { target: 'master', op: 'setSection', name: cmd.name, bars: cmd.bars });
          break;
        default:
          console.warn('unknown agent cmd type', cmd.type);
          continue;
      }
      if (expanded.op) queueAgentCommand(controlState, expanded);
    }
    return true;
  }
  // 内部旧格式：{target, op, ...}
  const allowed = command.target === 'master' ? agentMayControl(controlState, 'master') : agentMayControl(controlState, 'flock', command.objectId);
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

// ——— Master 最小集 ———
function refreshMasterHud() {
  const userHeld = controlState.master === USER;
  masterBadge.textContent = userHeld ? '主脉 · 由你掌握' : '主脉 · 生态自持';
  masterBadge.classList.toggle('user', userHeld);
  masterRelease.hidden = !userHeld;
  bpmSlider.value = String(world.tempo);
  bpmOutput.textContent = String(Math.round(world.tempo));
  chordQuality.value = scoreState.chord.quality;
  meterSelect.value = String(scoreState.beatsPerBar);
  loopBarsSelect.value = String(scoreState.loopBars);
}

function setMasterTempo(bpm, byUser = true) {
  world.tempo = Math.max(48, Math.min(140, Math.round(bpm)));
  if (byUser) takeoverMaster(controlState);
  pushTransport();
  refreshMasterHud();
}

function setMasterChord(rootMidi, quality, byUser = true) {
  if (Number.isFinite(rootMidi)) scoreState.chord = { ...scoreState.chord, rootMidi: Math.round(rootMidi) };
  if (quality && quality in CHORD_QUALITY_NAMES) scoreState.chord = { ...scoreState.chord, quality };
  if (byUser) takeoverMaster(controlState);
  if (scoreState.enabled) audio.setChord(scoreState.chord.rootMidi, scoreState.chord.quality);
  for (const session of liveSessions.values()) session.setChord(scoreState.chord);
  if (scoreState.enabled) {
    for (const voice of world.objects) {
      if (inInstrument(controlState, voice.id)) continue;
      if (controllerOf(controlState, voice.id) === USER) {
        const base = (scoreState.anchors.get(voice.id) ?? []).map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
        if (base.length) commitPattern(voice, shiftPattern(base, 0, 0, scoreState.chord, bandForChord(scoreState.chord, voice.role), scoreState.loopBeats));
      } else {
        assignFlockPattern(voice);
      }
    }
  }
  refreshMasterHud();
}

function setMasterLoop({ beatsPerBar, loopBars }) {
  if (Number.isFinite(beatsPerBar)) scoreState.beatsPerBar = beatsPerBar;
  if (Number.isFinite(loopBars)) scoreState.loopBars = loopBars;
  scoreState.loopBeats = scoreState.beatsPerBar * scoreState.loopBars;
  takeoverMaster(controlState);
  pushTransport();
  for (const session of liveSessions.values()) session.loopBeats = scoreState.loopBeats;
  if (scoreState.enabled) {
    for (const voice of world.objects) {
      if (inInstrument(controlState, voice.id)) continue;
      if (controllerOf(controlState, voice.id) === USER) {
        const base = (scoreState.anchors.get(voice.id) ?? []).map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
        if (base.length) commitPattern(voice, shiftPattern(base, 0, 0, scoreState.chord, bandForChord(scoreState.chord, voice.role), scoreState.loopBeats));
      } else {
        assignFlockPattern(voice);
      }
    }
  }
  refreshMasterHud();
}

function assignVoiceRole(objectId, role) {
  const voice = world.objects.find((candidate) => candidate.id === objectId);
  if (!voice || !(role in ROLE_BANDS)) return false;
  voice.role = role;
  voice.pitchRegister = role === 'bass' ? -1 : role === 'ornament' ? 1 : 0;
  if (!scoreState.enabled) return true;
  if (controllerOf(controlState, voice.id) === USER) {
    const base = (scoreState.anchors.get(voice.id) ?? []).map(({ beat, midi, durBeats, vel }) => ({ beat, midi, durBeats, vel }));
    commitPattern(voice, shiftPattern(base, 0, 0, scoreState.chord, bandForChord(scoreState.chord, role), scoreState.loopBeats));
  } else {
    assignFlockPattern(voice);
  }
  return true;
}

const CHORD_QUALITY_NAMES = { minor: '幽暗（小三）', major: '明亮（大三）', minor7: '雾霭（小七）', major7: '晨光（大七）', sus2: '悬浮（sus2）', sus4: '张力（sus4）' };

bpmSlider.addEventListener('input', () => { setMasterTempo(Number(bpmSlider.value)); status.textContent = `生命节律 ${world.tempo}——主脉已由你掌握`; });
chordQuality.addEventListener('change', () => { setMasterChord(undefined, chordQuality.value); status.textContent = `和声色彩 → ${CHORD_QUALITY_NAMES[scoreState.chord.quality]}`; });
meterSelect.addEventListener('change', () => { setMasterLoop({ beatsPerBar: Number(meterSelect.value) }); status.textContent = `节律类型 → ${meterSelect.value === '6' ? '6/8' : `${meterSelect.value}/4`}`; });
loopBarsSelect.addEventListener('change', () => { setMasterLoop({ loopBars: Number(loopBarsSelect.value) }); status.textContent = `生命周期长度 → ${scoreState.loopBars} 小节`; });
masterRelease.addEventListener('click', () => { releaseMaster(controlState); refreshMasterHud(); status.textContent = '主脉交还生态，以当前节律与和声为新基础'; });

function chooseHarmony(note, byUser = false) {
  setHarmonicCenter(world, note);
  setMasterChord(48 + note, undefined, byUser);
}
chooseHarmony(0);

// ——— 声部条 ———
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
      const roleOptions = Object.keys(ROLE_BANDS).map((role) => `<option value="${role}"${voice?.role === role ? ' selected' : ''}>${ROLE_NAMES[role] ?? role}</option>`).join('');
      return `<div class="voice-card" data-index="${item.index}">
        <div class="voice-card-header">
          <i style="--voice:hsl(${voice?.hue ?? 160} 70% 70%)"></i>
          <strong>V${item.index + 1} ${name}</strong>
          <em class="controller-badge">生态</em>
          <output>−∞</output>
        </div>
        <div class="voice-card-controls">
          <select data-action="role" aria-label="Voice ${item.index + 1} 音域带">${roleOptions}</select>
          <button data-action="mute">M</button>
          <button data-action="solo">S</button>
          <button data-action="take" class="take-button">接管</button>
        </div>
      </div>`;
    }).join('');
    voiceAudit.dataset.state = `voices-${diagnostics.length}`;
  }
  diagnostics.forEach((item) => {
    const card = voiceAudit.querySelector(`.voice-card[data-index="${item.index}"]`);
    if (!card) return;
    card.querySelector('output').textContent = item.db <= -100 ? '−∞' : `${item.db.toFixed(1)}`;
    const voice = world.objects[item.index];
    if (voice?.relationState) card.title = `8D 关系：${voice.relationState.map((value) => value.toFixed(2)).join(' · ')}`;
    card.querySelector('strong').textContent = `V${item.index + 1} ${SPECIES.find((species) => species.id === voice?.speciesId)?.name ?? 'Voice'}`;
    card.querySelector('[data-action="mute"]').classList.toggle('active', item.muted);
    card.querySelector('[data-action="solo"]').classList.toggle('active', item.solo);
    if (voice) {
      const held = controllerOf(controlState, voice.id) === USER;
      const badge = card.querySelector('.controller-badge');
      badge.textContent = inInstrument(controlState, voice.id) ? '下潜' : held ? '由你' : '生态';
      badge.classList.toggle('user', held);
      const take = card.querySelector('[data-action="take"]');
      take.textContent = held ? '交还' : '接管';
      take.classList.toggle('active', held);
      // 已有其他群被接管时，未接管群的按钮禁用（PRD：一次只深度接管一个）。
      const anyTaken = Array.from(controlState.flocks.values()).some((controller) => controller === USER);
      take.disabled = !held && anyTaken;
      const roleSelect = card.querySelector('select[data-action="role"]');
      if (roleSelect.value !== voice.role) roleSelect.value = voice.role;
    }
  });
}
voiceAudit.addEventListener('change', (event) => {
  const select = event.target.closest('select[data-action="role"]');
  const card = event.target.closest('.voice-card');
  if (!select || !card) return;
  const voice = world.objects[Number(card.dataset.index)];
  if (voice && assignVoiceRole(voice.id, select.value)) status.textContent = `Voice ${Number(card.dataset.index) + 1} 迁入${ROLE_NAMES[select.value] ?? select.value}音域带`;
});
voiceAudit.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('.voice-card');
  if (!button || !card) return;
  const index = Number(card.dataset.index);
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

// ——— 编排层画布交互 ———
function resize() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize); resize();
function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }

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
  const band = bandForChord(scoreState.chord, voice.role);
  const pattern = drag.type === 'pattern'
    ? shiftPattern(base, drag.dx * scoreState.loopBeats, yToMidiDrift(-drag.dy), scoreState.chord, band, scoreState.loopBeats)
    : moveNote(base, drag.index, base[drag.index].beat + drag.dx * scoreState.loopBeats, base[drag.index].midi + yToMidiDrift(-drag.dy), scoreState.chord, band, scoreState.loopBeats);
  commitPattern(voice, pattern);
  status.textContent = drag.type === 'pattern' ? `${voice.speciesName} 乐句整体平移 · 已在和弦内落位` : `${voice.speciesName} 单音已移动 · 和弦内量化`;
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId); const point = canvasPoint(event); pointer = { ...point, previousX: point.x, previousY: point.y };
  const hit = hitTakenFlock(point);
  if (hit) {
    anchorDrag = { flockId: hit.voice.id, type: hit.type, index: hit.index, startX: point.x, startY: point.y, dx: 0, dy: 0 };
    pointerLabel.classList.add('visible');
  }
});
canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return; const point = canvasPoint(event);
  pointer = { ...point, previousX: pointer.x, previousY: pointer.y };
  const rect = canvas.getBoundingClientRect(); pointerLabel.style.left = `${point.x * rect.width}px`; pointerLabel.style.top = `${point.y * rect.height}px`;
  if (anchorDrag) { anchorDrag.dx = wrappedDelta(point.x, anchorDrag.startX); anchorDrag.dy = point.y - anchorDrag.startY; }
});
function releasePointer() {
  pointer = null; pointerLabel.classList.remove('visible');
  if (anchorDrag) commitAnchorDrag();
}
canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer);

canvas.addEventListener('dblclick', (event) => {
  if (liveSession) return;
  const point = canvasPoint(event);
  let nearest = null; let nearestDistance = Infinity;
  for (const voice of world.objects) {
    const distance = Math.hypot(wrappedDelta(point.x, voice.centroid.x), point.y - voice.centroid.y);
    if (distance < nearestDistance) { nearest = voice; nearestDistance = distance; }
  }
  if (nearest) enterInstrument(nearest.id);
});

// ——— Instrument View（声音引擎层，单群全屏）———
function renderInstrumentControls() {
  const config = liveSession?.ecosystem.config;
  if (!config) return;
  instrumentParams.innerHTML = INSTRUMENT_CONTROL_SPECS.map((spec) => `<label class="parameter" title="${spec.hint}"><span>${spec.name}<output>${spec.format(config[spec.key])}</output></span><input type="range" data-control="${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${config[spec.key]}"></label>`).join('');
}
instrumentParams.addEventListener('input', (event) => {
  const input = event.target.closest('input[data-control]');
  if (!input || !liveSession) return;
  const spec = INSTRUMENT_CONTROL_SPECS.find((item) => item.key === input.dataset.control);
  const value = liveSession.setBoidsControl(input.dataset.control, Number(input.value));
  if (value === false) return;
  input.closest('label').querySelector('output').textContent = spec.format(value);
});

function renderKeyMap() {
  const keys = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK'];
  const noteNames = ['C4', 'C♯4', 'D4', 'E♭4', 'E4', 'F4', 'F♯4', 'G4', 'A♭4', 'A4', 'B♭4', 'B4', 'C5'];
  keyMap.innerHTML = keys.map((code, i) => `<div class="key" data-key="${code}"><span>${code.replace('Key', '')}</span><small>${noteNames[i]}</small></div>`).join('');
}
renderKeyMap();

function enterInstrument(flockId) {
  const voice = world.objects.find((candidate) => candidate.id === flockId);
  if (!voice) return;
  diveIn(controlState, flockId);
  let session = liveSessions.get(flockId);
  if (!session) { session = new LiveInstrumentSession({ flockId, chord: scoreState.chord, loopBeats: scoreState.loopBeats }); liveSessions.set(flockId, session); }
  session.setChord(scoreState.chord);
  session.jamming = false;
  liveSession = session;
  // 丝滑过渡：score 先淡出+微放大，instrument 从 0.92 缩放到 1。
  scoreView.classList.add('diving');
  instrumentView.hidden = false;
  requestAnimationFrame(() => {
    instrumentView.classList.add('active');
    setTimeout(() => { scoreView.hidden = true; }, 300);
  });
  instrumentName.textContent = `下潜 · ${voice.speciesName}`;
  recordCount.textContent = '录音环 · 0 音';
  renderInstrumentControls();
  resizeInstrument();
  status.textContent = `已下潜 ${voice.speciesName} · 上层其余声部照常循环 · Esc 返回`;
  refreshVoiceAudit();
}

function resizeInstrument() {
  const rect = instrumentCanvas.getBoundingClientRect();
  instrumentCanvas.width = Math.round(rect.width * dpr);
  instrumentCanvas.height = Math.round(rect.height * dpr);
  instrumentContext.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { if (!instrumentView.hidden) resizeInstrument(); });

function restoreFlockPattern(voice) {
  if (!voice) return;
  const pattern = scoreState.lastSent.get(voice.id);
  if (pattern) audio.setPattern(voice.id, pattern);
}

function exitInstrument(keepPhrase) {
  if (!liveSession) return;
  const voice = world.objects.find((candidate) => candidate.id === liveSession.flockId);
  if (keepPhrase) {
    const { notes, timbreBasis } = liveSession.takeRecording(quantizeRecording);
    if (timbreBasis) scoreState.timbreBases.set(liveSession.flockId, timbreBasis);
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
  // 丝滑过渡：instrument 缩小淡出，score 淡入。
  instrumentView.classList.remove('active');
  scoreView.hidden = false;
  scoreView.classList.remove('diving');
  setTimeout(() => { instrumentView.hidden = true; }, 400);
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
    if (!liveSession.jamming) { liveSession.jamming = true; audio.setPattern(liveSession.flockId, []); }
    liveSession.noteOn(key, midi, velocity, transportBeat());
    keyMap.querySelector(`[data-key="${key.replace('kb-', '')}"]`)?.classList.add('active');
  } else {
    liveSession.noteOff(key, transportBeat());
    keyMap.querySelector(`[data-key="${key.replace('kb-', '')}"]`)?.classList.remove('active');
  }
  recordCount.textContent = `录音环 · ${liveSession.recording.length} 音`;
}
window.addEventListener('keydown', (event) => {
  if (liveSession) {
    if (event.code === 'Escape') { exitInstrument(false); return; }
    const midi = KEY_NOTES[event.code];
    if (midi !== undefined && !event.repeat) { playLiveNote(`kb-${event.code}`, midi, 0.85, true); event.preventDefault(); }
  }
});
window.addEventListener('keyup', (event) => {
  if (liveSession && KEY_NOTES[event.code] !== undefined) playLiveNote(`kb-${event.code}`, KEY_NOTES[event.code], 0.85, false);
});

// Instrument 画布交互：拖拽引导群形。
instrumentCanvas.addEventListener('pointerdown', (event) => {
  instrumentCanvas.setPointerCapture(event.pointerId);
  const rect = instrumentCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (liveSession) liveSession.guide(x, y, true);
});
instrumentCanvas.addEventListener('pointermove', (event) => {
  if (!liveSession || !instrumentCanvas.hasPointerCapture(event.pointerId)) return;
  const rect = instrumentCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  liveSession.guide(x, y, true);
});
instrumentCanvas.addEventListener('pointerup', () => { if (liveSession) liveSession.guide(0, 0, false); });
instrumentCanvas.addEventListener('pointercancel', () => { if (liveSession) liveSession.guide(0, 0, false); });

// ——— 音频启动（Web Audio 轻量合成器，无 server 依赖）———
audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(world.objects); else await audio.toggle();
  if (audio.running && !scoreState.enabled) activateScore();
  const failed = audio.mode === 'audio-error';
  audioButton.textContent = failed ? '声音加载失败' : audio.running ? '暂停声音' : '继续声音';
  audioButton.classList.toggle('running', audio.running && !failed);
  engineFact.textContent = failed ? '声音链：合成器失败，已静音' : '声音链：Web Audio 轻量合成器 · 4 Voice';
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

// ——— 渲染 ———
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
  // Pattern anchor 光晕 + 拖拽预览。
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
      // 扫描线扫过 anchor 时触发粒子（PRD §3.1）。
      if (scoreState.enabled && Math.abs(wrappedDelta(world.pulsePosition, anchor.x)) < 0.01 && !anchor.triggered) {
        spawnParticles(x, y, voice.hue);
        anchor.triggered = true;
        setTimeout(() => { anchor.triggered = false; }, 200);
      }
    });
  }
  // 粒子。
  for (const p of particles) {
    context.beginPath(); context.arc(p.x, p.y, 2.5 * p.life, 0, TAU);
    context.fillStyle = `hsla(${p.hue},80%,75%,${p.life * 0.8})`;
    context.fill();
  }
  // 每群头顶常驻小徽标。
  for (const voice of world.objects) {
    const held = controllerOf(controlState, voice.id) === USER;
    const x = voice.centroid.x * width; const y = voice.centroid.y * height - 20;
    context.beginPath(); context.arc(x, y, 3.2, 0, TAU);
    if (held) { context.fillStyle = 'rgba(169,239,207,.92)'; context.fill(); }
    else { context.strokeStyle = `hsla(${voice.hue},60%,70%,.4)`; context.lineWidth = 1; context.stroke(); }
  }
  for (const boid of world.boids) {
    const voice = world.objects.find((candidate) => candidate.id === boid.flockId); const x = boid.x * width; const y = boid.y * height; const heading = Math.atan2(boid.vy, boid.vx);
    context.save(); context.translate(x, y); context.rotate(heading); context.fillStyle = `hsla(${voice?.hue ?? 160},72%,72%,.82)`;
    context.beginPath(); context.moveTo(7, 0); context.lineTo(-4, 3.4); context.lineTo(-2.5, 0); context.lineTo(-4, -3.4); context.closePath(); context.fill(); context.restore();
  }
}

function drawInstrument() {
  const width = instrumentCanvas.clientWidth; const height = instrumentCanvas.clientHeight; instrumentContext.clearRect(0, 0, width, height);
  const voice = world.objects.find((candidate) => candidate.id === liveSession.flockId);
  const hue = voice?.hue ?? 160;
  const backdrop = instrumentContext.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, width * 0.6);
  backdrop.addColorStop(0, `hsla(${hue},45%,16%,.5)`); backdrop.addColorStop(1, 'rgba(2,8,8,0)');
  instrumentContext.fillStyle = backdrop; instrumentContext.fillRect(0, 0, width, height);
  const ecosystem = liveSession.ecosystem;
  for (const bird of ecosystem.birds) {
    const depth = (bird.z - 0.5) / 0.9 + 0.5;
    const radius = 1.6 + depth * 3.2;
    instrumentContext.beginPath(); instrumentContext.arc(bird.x * width, bird.y * height, radius, 0, TAU);
    instrumentContext.fillStyle = `hsla(${hue},72%,${58 + depth * 20}%,${0.35 + depth * 0.45})`;
    instrumentContext.fill();
  }
  if (ecosystem.target) {
    const x = ecosystem.target.x * width; const y = ecosystem.target.y * height;
    instrumentContext.beginPath(); instrumentContext.arc(x, y, 12, 0, TAU); instrumentContext.strokeStyle = 'rgba(169,239,207,.5)'; instrumentContext.lineWidth = 1; instrumentContext.stroke();
  }
  // 小型扫描环：上层循环相位。
  if (audio.transport) {
    const phase = audio.transport.beat / Math.max(1e-6, audio.transport.loopBeats);
    const cx = width - 52; const cy = 52;
    instrumentContext.beginPath(); instrumentContext.arc(cx, cy, 20, 0, TAU); instrumentContext.strokeStyle = 'rgba(130,190,174,.2)'; instrumentContext.lineWidth = 2; instrumentContext.stroke();
    instrumentContext.beginPath(); instrumentContext.arc(cx, cy, 20, -Math.PI / 2, -Math.PI / 2 + phase * TAU); instrumentContext.strokeStyle = 'rgba(255,178,116,.7)'; instrumentContext.stroke();
  }
  // 按住的音：底部音名行。
  const held = Array.from(liveSession.held.values(), (entry) => NOTES[((entry.midi % 12) + 12) % 12]).join(' ');
  if (held) {
    instrumentContext.font = '18px ui-monospace, SFMono-Regular, monospace'; instrumentContext.fillStyle = 'rgba(169,239,207,.8)';
    instrumentContext.fillText(held, 32, height - 88);
  }
}

function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000); lastTime = time;
  stepWorld(world, dt); syncScoreWithTransport(); stepParticles(dt);
  if (liveSession) {
    liveSession.step(dt);
    if (liveSession.jamming) audio.setVoiceOverride(liveSession.flockId, liveSession.controlOverride());
  }
  audio.update(world);
  if (liveSession) drawInstrument(); else draw();
  if (time - lastVoiceAudit > 250) { refreshVoiceAudit(); lastVoiceAudit = time; }
  requestAnimationFrame(frame);
}
refreshMasterHud();
requestAnimationFrame(frame);
window.latentCosmos = { exportSession: () => recorder.export(), world, audio, applyAgentCommand, controlState, debugDive: (flockId) => enterInstrument(flockId) };
