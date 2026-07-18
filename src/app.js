// 应用主循环 v4：一个世界，一台摄像机，日夜是唯一的大循环。
// 枝干分叉就是 note——鸟落在枝干上，扫描的光轮到它就叫唤。没有节拍器，没有步进格。

import { createWorld, stepWorld, rebuildBranches, currentScore, setInteraction, SPECIES, TAU } from './world.js';
import { spawnPestWave, ecosystemHealth, stagnation } from './eco/economy.js';
import { flockPolicy, masterPolicy } from './eco/agent.js';
import { MinimaxFlockAgent } from './eco/llm-agent.js';
import { CHORD_QUALITIES } from './score.js';
import { AGENT, USER, createControlState, diveIn, drainAgentCommands, queueAgentCommand, release, returnToScore, controllerOf } from './control.js';
import { PerceptualWebAudioEngine } from './audio-engine.js';
import { SessionRecorder } from './session.js';
import {
  SEASON_TO_CHORD, velocityFromPerchCount, richnessFromFoliage,
  impurityFromPest, dayNightMacros, masterFromHealth, mixFromCamera,
} from './eco/mapping.js';

const canvas = document.querySelector('#world');
const ctx = canvas.getContext('2d');
const world = createWorld();
const recorder = new SessionRecorder(world);
const audio = new PerceptualWebAudioEngine();
const controlState = createControlState();

const $ = (sel) => document.querySelector(sel);
const audioButton = $('#audio-button');
const engineFact = $('#engine-fact');
const status = $('#status');
const masterBadge = $('#master-badge');
const bpmSlider = $('#bpm-slider');
const bpmOutput = $('#bpm-output');
const chordQuality = $('#chord-quality');
const voiceAudit = $('#voice-audit');
const keyMap = $('#key-map');
const ecoHud = $('#eco-hud');

// ——— 摄像机 ———
const camera = { cx: 0.5, cy: 0.5, scale: 1, u: 0, target: { cx: 0.5, cy: 0.5, scale: 1 } };
let focusFlockId = null;

// ——— 和声 ———
const chordState = { rootMidi: 57, quality: 'minor' };
const ROLE_BANDS = { bass: { lo: -12, hi: -7 }, support: { lo: 0, hi: 7 }, ornament: { lo: 7, hi: 14 }, shimmer: { lo: 0, hi: 12 } };
const bandForRole = (role) => {
  const band = ROLE_BANDS[role] ?? ROLE_BANDS.support;
  return { loMidi: chordState.rootMidi + band.lo, hiMidi: chordState.rootMidi + band.hi };
};
function applyChord() {
  const intervals = CHORD_QUALITIES[chordState.quality] ?? CHORD_QUALITIES.minor;
  rebuildBranches(world, { rootMidi: chordState.rootMidi, intervals }, bandForRole);
  audio.setChord(chordState.rootMidi, chordState.quality);
}

let enabled = false; // 声音是否已唤醒
function takeoverMaster() { controlState.master = USER; masterBadge.textContent = '你说了算'; masterBadge.classList.add('user'); }
function setMasterTempo(bpm, byUser = true) {
  world.tempo = Math.max(48, Math.min(140, Math.round(bpm)));
  if (byUser) takeoverMaster();
  bpmSlider.value = String(world.tempo); bpmOutput.textContent = String(world.tempo);
}
function setMasterChord(quality, byUser = true) {
  chordState.quality = quality;
  if (byUser) takeoverMaster();
  chordQuality.value = quality;
  applyChord();
}
function applySeason(seasonIndex) {
  world.season = ((seasonIndex % 4) + 4) % 4;
  const quality = SEASON_TO_CHORD[['spring', 'summer', 'autumn', 'winter'][world.season]];
  chordState.quality = quality;
  chordQuality.value = quality;
  applyChord();
}

// ——— 枝干发声：鸟落枝即鸣 ———
// 没有节拍器。鸟落在哪根枝，就发那根枝的音；栖鸟越多越响，驻留越久音越长。
// 触发由「栖落事件」驱动（鸟的 perched 状态从空变为某枝）。
const sounded = new Map(); // boidId → 上次发声的世界秒
function triggerPerchedBirds() {
  if (!enabled) return;
  const health = ecosystemHealth(world);
  const dn = dayNightMacros(world.dayPhase);
  const master = masterFromHealth(health.mean);
  audio.setMasterMacros({ brightness: master.brightness, lofiMix: master.lofiMix, filterMacro: dn.filterMacro });
  const mixFocus = mixFromCamera(camera.u, focusFlockId, world.trees.map((t) => t.id));
  // 音色按树设置一次。
  world.trees.forEach((tree, index) => {
    const flock = world.flocks[index];
    audio.setVoiceOverride(tree.id, {
      relationState: flock.relationState.slice(0, 8),
      eco: { richness: richnessFromFoliage(tree.foliage), impurity: impurityFromPest(tree.pest) },
      focusGain: mixFocus[tree.id] ?? 1,
    });
  });
  // 每根枝上的栖鸟 → 该枝的音。按 (tree, branch) 聚合。
  const byPerch = new Map();
  for (const boid of world.boids) {
    if (!boid.perched) continue;
    const key = `${boid.perched.treeId}:${boid.perched.branch}`;
    if (!byPerch.has(key)) byPerch.set(key, []);
    byPerch.get(key).push(boid);
  }
  for (const [key, group] of byPerch) {
    const tree = world.trees[group[0].perched.treeId];
    const perch = tree?.branches[group[0].perched.branch];
    if (!perch) continue;
    // 只在「有新鸟落上」或驻留整拍时发声，避免每帧重触发。
    const fresh = group.some((b) => b.dwell < 0.15);
    const lastKey = `t${key}`;
    const last = sounded.get(lastKey) ?? -Infinity;
    if (!fresh && world.time - last < 0.8) continue;
    if (world.time - last < 0.15) continue;
    const synth = audio.ensureVoice(tree.id);
    synth.setMidi(perch.midi);
    synth.trigger(velocityFromPerchCount(group.length) * dn.densityCap, Math.max(0.5, Math.min(2.5, Math.max(...group.map((b) => b.dwell)) + 0.5)));
    sounded.set(lastKey, world.time);
    tree.lastChirp = world.time;
    tree.lastChirpBranch = group[0].perched.branch;
  }
}

// ——— Agent Control API（玮圣接口不变）———
function addBoidLike(flockId) { const tree = world.trees[flockId]; if (tree) world.boids.push({ id: world.nextBoidId++, flockId, x: tree.slot.x, y: tree.slot.y - 0.2, vx: 0, vy: 0, perched: null, dwell: 0, wanderPhase: 0, wanderOffset: 0 }); }
function removeBoidLike(flockId) { const i = world.boids.findIndex((b) => b.flockId === flockId); if (i >= 0) world.boids.splice(i, 1); }
function executeAgentCommand(command) {
  try {
    if (command.target === 'master') {
      if (command.op === 'setTempo') setMasterTempo(command.bpm, false);
      if (command.op === 'setChord' && command.quality) setMasterChord(command.quality, false);
      if (command.op === 'spawnPestWave') spawnPestWave(world, command.treeId ?? 0, command.intensity ?? 0.3);
      if (command.op === 'setDaynight' && Number.isFinite(command.bars)) world.dayLengthBeats = Math.max(8, command.bars * 4);
      if (command.op === 'setPopulation') {
        const flock = world.flocks[command.flock ?? 0];
        if (flock && command.delta > 0) for (let i = 0; i < command.delta; i += 1) addBoidLike(flock.id);
        if (flock && command.delta < 0) for (let i = 0; i < -command.delta; i += 1) removeBoidLike(flock.id);
      }
    } else if (command.target === 'flock') {
      const flock = world.flocks[command.objectId];
      if (!flock) return;
      if (command.op === 'setDensity' && Number.isFinite(command.value)) flock.dwellUrge = Math.max(0, Math.min(1, command.value));
      if (command.op === 'setMotion' && Number.isFinite(command.wander)) world.config.wanderStrength = command.wander;
    }
  } catch (error) { console.warn('agent command rejected', command, error); }
}
function applyAgentCommand(command) {
  if (!command || typeof command !== 'object') return false;
  if (Array.isArray(command.cmds)) {
    const atBar = Number.isFinite(command.at_bar) ? { atBar: command.at_bar } : {};
    const isFlock = Number.isFinite(command.flock);
    for (const cmd of command.cmds) {
      const expanded = { ...(isFlock ? { target: 'flock', objectId: command.flock } : { target: 'master' }), ...atBar };
      switch (cmd.type) {
        case 'set_bpm': if (Number.isFinite(cmd.value)) Object.assign(expanded, { op: 'setTempo', bpm: cmd.value }); break;
        case 'set_scale': if (cmd.mode) Object.assign(expanded, { op: 'setChord', quality: cmd.mode }); break;
        case 'set_daynight': if (Number.isFinite(cmd.bars)) Object.assign(expanded, { op: 'setDaynight', bars: cmd.bars }); break;
        case 'spawn_pest_wave': Object.assign(expanded, { op: 'spawnPestWave', treeId: cmd.tree ?? 0, intensity: cmd.intensity ?? 0.3 }); break;
        case 'set_population': if (Number.isFinite(cmd.flock) && Number.isFinite(cmd.delta)) Object.assign(expanded, { op: 'setPopulation', flock: cmd.flock, delta: cmd.delta }); break;
        case 'set_density': if (isFlock && Number.isFinite(cmd.value)) Object.assign(expanded, { op: 'setDensity', value: cmd.value }); break;
        case 'set_motion': if (isFlock) Object.assign(expanded, { op: 'setMotion', wander: cmd.wander }); break;
        default: console.warn('unknown agent cmd', cmd.type); continue;
      }
      if (expanded.op) queueAgentCommand(controlState, expanded);
    }
    return true;
  }
  queueAgentCommand(controlState, command);
  return true;
}

// ——— 键盘召唤（贴近 = 落鸟写谱）———
const KEY_NOTES = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12 };
function renderKeyMap() {
  if (!keyMap) return;
  keyMap.innerHTML = Object.keys(KEY_NOTES).map((code, i) => `<div class="key" data-key="${code}"><span>${code.replace('Key', '')}</span><small>${i}</small></div>`).join('');
}
renderKeyMap();
function summonBird(degreeOffset) {
  if (focusFlockId === null) return;
  const tree = world.trees[focusFlockId];
  if (!tree?.branches.length) return;
  // 按键序号 → 按音高排序的第几根枝（0=最低音枝）。一枝一个音，明确可辨。
  const sorted = [...tree.branches].sort((a, b) => a.midi - b.midi);
  const perch = sorted[degreeOffset % sorted.length];
  const branchIdx = perch.branch;
  const flying = world.boids.find((b) => b.flockId === focusFlockId && !b.perched);
  const synth = audio.ensureVoice(tree.id);
  synth.setMidi(perch.midi);
  synth.trigger(0.85, 0.7);
  if (flying) { flying.perched = { treeId: tree.id, branch: branchIdx }; flying.dwell = 0; flying.x = perch.x; flying.y = perch.y; }
  tree.lastChirp = world.time;
  tree.lastChirpBranch = branchIdx;
  const key = Object.keys(KEY_NOTES)[degreeOffset];
  keyMap.querySelector(`[data-key="${key}"]`)?.classList.add('active');
  setTimeout(() => keyMap.querySelector(`[data-key="${key}"]`)?.classList.remove('active'), 180);
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && focusFlockId !== null) { zoomOut(); return; }
  const degree = KEY_NOTES[event.code];
  if (degree !== undefined && !event.repeat && focusFlockId !== null) { summonBird(degree); event.preventDefault(); }
});

// ——— 指针：引导 + 双击贴近 ———
let pointer = null;
function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }
function screenToWorld(point) { return { x: camera.cx + (point.x - 0.5) / camera.scale, y: camera.cy + (point.y - 0.5) / camera.scale }; }
canvas.addEventListener('pointerdown', (event) => { canvas.setPointerCapture(event.pointerId); pointer = canvasPoint(event); const w = screenToWorld(pointer); setInteraction(world, { mode: 'guide', x: w.x, y: w.y }); });
canvas.addEventListener('pointermove', (event) => { if (!pointer) return; pointer = canvasPoint(event); const w = screenToWorld(pointer); setInteraction(world, { mode: 'guide', x: w.x, y: w.y }); });
const endGuide = () => { pointer = null; setInteraction(world, null); };
canvas.addEventListener('pointerup', endGuide); canvas.addEventListener('pointercancel', endGuide);
canvas.addEventListener('dblclick', (event) => {
  const w = screenToWorld(canvasPoint(event));
  let nearest = 0; let best = Infinity;
  world.trees.forEach((tree, i) => { const d = Math.hypot(w.x - tree.slot.x, w.y - tree.slot.y); if (d < best) { best = d; nearest = i; } });
  zoomInto(nearest);
});

// ——— Zoom ———
function zoomInto(flockId) {
  focusFlockId = flockId;
  const tree = world.trees[flockId];
  diveIn(controlState, flockId);
  camera.target = { cx: tree.slot.x, cy: tree.slot.y - world.config.canopyHeight * 0.4, scale: 2.6 };
  status.textContent = `凑近 ${tree.treeName}：A–K 落鸟，Esc 退出来。`;
}
function zoomOut() {
  if (focusFlockId !== null) release(controlState, focusFlockId);
  focusFlockId = null;
  returnToScore(controlState);
  camera.target = { cx: 0.5, cy: 0.5, scale: 1 };
  status.textContent = '退出来了，树还是自己管自己。';
}
function stepCamera(dt) {
  const k = 1 - Math.exp(-dt * 4);
  camera.cx += (camera.target.cx - camera.cx) * k;
  camera.cy += (camera.target.cy - camera.cy) * k;
  camera.scale += (camera.target.scale - camera.scale) * k;
  camera.u = Math.min(1, Math.max(0, (camera.scale - 1) / 1.6));
}

// ——— Agent 兜底（G7）：LLM 个性层 + 代码兜底 ———
let masterCooldown = 0;
let lastDayPhase = 0;
let dawnChorusUntil = 0;
let absoluteBar = 0;
// MiniMax 个性层（key 由用户在页面注入；未配置则纯代码兜底）。
let llmAgent = null;
export function configureLlm(apiKey) {
  llmAgent = apiKey ? new MinimaxFlockAgent({ apiKey }) : null;
  return Boolean(llmAgent);
}
const DAY_NAME = (p) => (p > 0.2 && p < 0.5 ? 'day' : p > 0.5 && p < 0.8 ? 'dusk' : 'night');
function flockState(flock) {
  const tree = world.trees[flock.homeTreeId];
  return {
    species: flock.speciesId,
    dayPhase: DAY_NAME(world.dayPhase),
    energy: Number(flock.energy.toFixed(2)),
    perchFlyRatio: Number((flock.population ? flock.perchedCount / flock.population : 0).toFixed(2)),
    foliage: Number(tree.foliage.toFixed(2)),
    pest: Number(tree.pest.toFixed(2)),
    neighborActivity: Number((world.flocks.filter((f) => f.id !== flock.id).reduce((s, f) => s + f.meanSpeed, 0) / Math.max(1, world.flocks.length - 1)).toFixed(3)),
  };
}
async function runAgents() {
  const inDawn = world.time < dawnChorusUntil;
  for (const flock of world.flocks) {
    if (controllerOf(controlState, flock.id) !== AGENT) continue;
    const fallback = flockPolicy(world, flock);
    let dwellUrge = inDawn ? Math.min(fallback.dwellUrge, 0.35) : fallback.dwellUrge;
    // LLM 个性层：成功则用其倾向，失败回退代码兜底。
    if (llmAgent) {
      const decision = await llmAgent.decide(flockState(flock)).catch(() => null);
      if (decision) dwellUrge = inDawn ? Math.min(decision.dwellUrge, 0.35) : decision.dwellUrge;
    }
    flock.dwellUrge = dwellUrge;
  }
  absoluteBar += 1;
  if (absoluteBar % 4 === 0) {
    const health = ecosystemHealth(world);
    const ops = masterPolicy(world, health, stagnation(world), masterCooldown);
    for (const op of ops) {
      if (op.type === 'spawn_pest_wave') { spawnPestWave(world, op.tree, op.intensity); masterCooldown = 8; }
      if (op.type === 'set_population') { for (let i = 0; i < Math.abs(op.delta); i += 1) op.delta > 0 ? addBoidLike(op.flock) : removeBoidLike(op.flock); }
      if (op.type === 'set_scale') setMasterChord(op.mode, false);
    }
    masterCooldown = Math.max(0, masterCooldown - 1);
  }
  for (const command of drainAgentCommands(controlState, absoluteBar)) executeAgentCommand(command);
}

// ——— 音频启动 ———
audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(world.flocks); else await audio.toggle();
  if (audio.running && !enabled) { enabled = true; applyChord(); }
  audioButton.textContent = audio.running ? '停一下' : '继续';
  audioButton.classList.toggle('running', audio.running);
  engineFact.textContent = 'Web Audio 合成，四棵树';
});

// ——— HUD ———
bpmSlider.addEventListener('input', () => setMasterTempo(Number(bpmSlider.value)));
chordQuality.addEventListener('change', () => setMasterChord(chordQuality.value));
document.querySelector('#master-release')?.addEventListener('click', () => { controlState.master = AGENT; masterBadge.textContent = '自己长着'; masterBadge.classList.remove('user'); });
const SEASON_NAMES = ['春', '夏', '秋', '冬'];
function refreshHud() {
  const health = ecosystemHealth(world);
  if (ecoHud) {
    ecoHud.innerHTML = world.trees.map((t) => `<span class="eco-tree" style="--h:${t.hue}"><i></i>${t.treeName} <b>${(t.foliage * 100) | 0}</b>${t.pest > 0.05 ? `<em>虫${(t.pest * 100) | 0}</em>` : ''}</span>`).join('')
      + `<span class="eco-meta">${SEASON_NAMES[world.season]} · ${world.dayPhase > 0.5 ? '夜' : '昼'} · 均值 ${(health.mean * 100) | 0}</span>`;
  }
  if (voiceAudit) {
    voiceAudit.innerHTML = world.trees.map((t, i) => {
      const f = world.flocks[i];
      const held = controllerOf(controlState, t.id) === USER;
      return `<div class="voice-card"><div class="voice-card-header"><i style="--voice:hsl(${t.hue} 70% 70%)"></i><strong>${t.treeName} · ${t.speciesName}</strong><em class="controller-badge${held ? ' user' : ''}">${held ? '由你' : '生态'}</em><output>${f.perchedCount}栖/${f.flyingCount}飞</output></div></div>`;
    }).join('');
  }
}

// ——— 渲染：委托给绘本渲染器（subagent 实现）———
let renderer = null;
import('./eco/storybook-renderer.js').then((mod) => { renderer = new mod.StorybookRenderer(canvas); renderer.resize(); }).catch(() => { renderer = null; });
function resize() { renderer?.resize(); }
window.addEventListener('resize', resize);

// ——— 主循环 ———
let lastTime = performance.now();
let lastHud = 0;
let agentTimer = 0;
function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000); lastTime = time;
  stepWorld(world, dt);
  stepCamera(dt);
  if (world.dayPhase < lastDayPhase) { dawnChorusUntil = world.time + 6; status.textContent = '天亮了，鸟都醒了。'; }
  lastDayPhase = world.dayPhase;
  // agent：约每「bar」评估一次（用世界时间节流，不依赖节拍器）。
  agentTimer += dt;
  if (agentTimer > 1.8) { agentTimer = 0; runAgents(); }
  triggerPerchedBirds();
  audio.update(world);
  if (renderer) renderer.draw(world, camera, focusFlockId, dt);
  if (time - lastHud > 300) { refreshHud(); lastHud = time; }
  requestAnimationFrame(frame);
}
applyChord();
requestAnimationFrame(frame);
window.latentCosmos = { exportSession: () => recorder.export(), world, audio, applyAgentCommand, controlState, camera, zoomInto, zoomOut, applySeason, configureLlm, spawnPestWave: (t, i) => spawnPestWave(world, t, i) };
