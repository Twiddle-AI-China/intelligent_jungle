// 应用主循环 v3：一个世界，一台摄像机。
// 编排层与声音引擎层是同一世界的两个焦距（设计 v3.3 §4）——
// 双击某树 = 镜头贴近（u→1），返回 = 缩出（u→0）且自动交还。

import { createWorld, stepWorld, rebuildBranches, currentScore, setInteraction, SPECIES, TREE_SLOTS, TAU } from './world.js';
import { stepEconomy, spawnPestWave, ecosystemHealth, stagnation } from './eco/economy.js';
import { flockPolicy, masterPolicy } from './eco/agent.js';
import { chordTones, bandForChord, CHORD_QUALITIES, PITCH_AXIS } from './score.js';
import { AGENT, USER, createControlState, diveIn, drainAgentCommands, inInstrument, queueAgentCommand, release, returnToScore, takeover, controllerOf } from './control.js';
import { PerceptualWebAudioEngine } from './audio-engine.js';
import { SessionRecorder } from './session.js';
import {
  SEASON_TO_CHORD, velocityFromPerchCount, timbreFromHalo, richnessFromFoliage,
  impurityFromPest, dayNightMacros, masterFromHealth, mixFromCamera,
} from './eco/mapping.js';

const canvas = document.querySelector('#world');
const ctx = canvas.getContext('2d');
const world = createWorld();
const recorder = new SessionRecorder(world);
const audio = new PerceptualWebAudioEngine();
const controlState = createControlState();

// DOM
const audioButton = document.querySelector('#audio-button');
const engineFact = document.querySelector('#engine-fact');
const status = document.querySelector('#status');
const masterBadge = document.querySelector('#master-badge');
const bpmSlider = document.querySelector('#bpm-slider');
const bpmOutput = document.querySelector('#bpm-output');
const chordQuality = document.querySelector('#chord-quality');
const voiceAudit = document.querySelector('#voice-audit');
const keyMap = document.querySelector('#key-map');
const ecoHud = document.querySelector('#eco-hud');

// ——— 摄像机 ———
const camera = { cx: 0.5, cy: 0.5, scale: 1, u: 0, target: { cx: 0.5, cy: 0.5, scale: 1 } };
let focusFlockId = null; // 下潜的树（=声部）

// ——— 和声与乐谱 ———
const scoreState = {
  enabled: false,
  loopBeats: 16,
  chord: { rootMidi: 57, quality: 'minor' },
  lastSentScore: null,
  absoluteBar: 0,
  lastBar: -1,
};
// 音域带（PRD §4）：相对根音的半音偏移。
const ROLE_BANDS = { bass: { lo: -12, hi: -7 }, support: { lo: 0, hi: 7 }, ornament: { lo: 7, hi: 14 }, shimmer: { lo: 0, hi: 12 } };
const bandForRole = (role) => {
  const band = ROLE_BANDS[role] ?? ROLE_BANDS.support;
  return { loMidi: scoreState.chord.rootMidi + band.lo, hiMidi: scoreState.chord.rootMidi + band.hi };
};

function applyChord() {
  const intervals = CHORD_QUALITIES[scoreState.chord.quality] ?? CHORD_QUALITIES.minor;
  rebuildBranches(world, { rootMidi: scoreState.chord.rootMidi, intervals }, bandForRole);
  audio.setChord(scoreState.chord.rootMidi, scoreState.chord.quality);
}

function setMasterTempo(bpm, byUser = true) {
  world.tempo = Math.max(48, Math.min(140, Math.round(bpm)));
  if (byUser) takeoverMaster();
  bpmSlider.value = String(world.tempo);
  bpmOutput.textContent = String(world.tempo);
  pushTransport();
}
function takeoverMaster() { controlState.master = USER; masterBadge.textContent = '主脉 · 由你掌握'; masterBadge.classList.add('user'); }

function setMasterChord(quality, byUser = true) {
  scoreState.chord = { ...scoreState.chord, quality };
  if (byUser) takeoverMaster();
  chordQuality.value = quality;
  applyChord();
}

function pushTransport() {
  if (!scoreState.enabled) return;
  audio.setTransport({ bpm: world.tempo, beatsPerBar: 4, loopBars: scoreState.loopBeats / 4, playing: true });
}

// ——— 季节 / 昼夜 ———
function applySeason(seasonIndex) {
  world.season = ((seasonIndex % 4) + 4) % 4;
  const quality = SEASON_TO_CHORD[['spring', 'summer', 'autumn', 'winter'][world.season]];
  scoreState.chord = { ...scoreState.chord, quality };
  chordQuality.value = quality;
  applyChord();
}

// ——— 乐谱 → 合成器 ———
// 把栖落占用翻译成音符，喂给 audio engine 的 pattern 触发器。
function syncScoreToAudio() {
  if (!scoreState.enabled || !audio.transport) return;
  const score = currentScore(world, scoreState.loopBeats);
  const health = ecosystemHealth(world);
  const dn = dayNightMacros(world.dayPhase);
  const master = masterFromHealth(health.mean);
  audio.setMasterMacros({ brightness: master.brightness, lofiMix: master.lofiMix, filterMacro: dn.filterMacro });
  const mixFocus = mixFromCamera(camera.u, focusFlockId, world.trees.map((t) => t.id));
  world.trees.forEach((tree, index) => {
    const flock = world.flocks[index];
    const notes = score[index].map((note) => ({
      beat: note.beat,
      midi: note.midi,
      durBeats: Math.max(0.3, Math.min(2, note.dwellBeats)),
      vel: velocityFromPerchCount(note.count) * dn.densityCap, // 昼夜密度上限
      guest: note.guest,
    }));
    audio.setPattern(tree.id, notes);
    // 音色：光环 8D + 生态中间属性（繁茂度/虫害）+ 镜头混音焦点。
    audio.setVoiceOverride(tree.id, {
      relationState: flock.relationState.slice(0, 8),
      eco: {
        richness: richnessFromFoliage(tree.foliage),
        impurity: impurityFromPest(tree.pest),
      },
      focusGain: mixFocus[tree.id] ?? 1,
    });
  });
}

// ——— Agent Control API（玮圣接口不变）———
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
      if (command.op === 'setMotion') { if (Number.isFinite(command.wander)) world.config.wanderStrength = command.wander; }
    }
  } catch (error) { console.warn('agent command rejected', command, error); }
}
function addBoidLike(flockId) { const tree = world.trees[flockId]; if (tree) world.boids.push({ id: world.nextBoidId++, flockId, x: tree.slot.x, y: tree.slot.y - 0.2, vx: 0, vy: 0, perched: null, dwell: 0, wanderPhase: 0, wanderOffset: 0 }); }
function removeBoidLike(flockId) { const i = world.boids.findIndex((b) => b.flockId === flockId); if (i >= 0) world.boids.splice(i, 1); }

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

// ——— 键盘召唤（下潜 = 落鸟写谱，G5）———
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
  // 当前拍位 → 最近 step；按键 → 选枝干。
  const step = Math.round(world.pulsePosition * world.config.stepsPerLoop) % world.config.stepsPerLoop;
  const branches = [...new Set(tree.branches.map((p) => p.branch))].sort((a, b) => a - b);
  const branch = branches[Math.min(branches.length - 1, degreeOffset % branches.length)];
  const perch = tree.branches.find((p) => p.branch === branch && p.step === step);
  if (!perch) return;
  // 一只飞鸟落枝：立即有声（演奏零延迟），鸟随后落位。
  const flock = world.flocks[focusFlockId];
  const flying = world.boids.find((b) => b.flockId === focusFlockId && !b.perched);
  const synth = audio.ensureVoice(tree.id);
  synth.setMidi(perch.midi);
  synth.trigger(0.85, 0.5);
  if (flying) { flying.perched = { treeId: tree.id, branch, step }; flying.dwell = 0; flying.x = perch.x; flying.y = perch.y; }
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && focusFlockId !== null) { zoomOut(); return; }
  const degree = KEY_NOTES[event.code];
  if (degree !== undefined && !event.repeat && focusFlockId !== null) { summonBird(degree); event.preventDefault(); }
});

// ——— 指针：引导 + 双击下潜 ———
let pointer = null;
function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }
function screenToWorld(point) {
  return { x: camera.cx + (point.x - 0.5) / camera.scale, y: camera.cy + (point.y - 0.5) / camera.scale };
}
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
  status.textContent = `贴近 ${tree.treeName} · 键盘 A–K 召唤落鸟 · Esc 缩出`;
}
function zoomOut() {
  if (focusFlockId !== null) release(controlState, focusFlockId); // 缩出即交还
  focusFlockId = null;
  returnToScore(controlState);
  camera.target = { cx: 0.5, cy: 0.5, scale: 1 };
  status.textContent = '已交还 · 四树全景';
}
function stepCamera(dt) {
  const k = 1 - Math.exp(-dt * 4);
  camera.cx += (camera.target.cx - camera.cx) * k;
  camera.cy += (camera.target.cy - camera.cy) * k;
  camera.scale += (camera.target.scale - camera.scale) * k;
  camera.u = Math.min(1, Math.max(0, (camera.scale - 1) / 1.6));
}

// ——— Agent 兜底（G7）：LLM 掉线时代码策略接管，循环永不停 ———
let masterCooldown = 0;
function runAgents(bar) {
  // 种群 agent：每 bar 评估 5 条规则 → dwellUrge/anchor。AGENT 控制的 flock 才生效。
  for (const flock of world.flocks) {
    if (controllerOf(controlState, flock.id) !== AGENT) continue;
    const action = flockPolicy(world, flock);
    flock.dwellUrge = action.dwellUrge;
    if (action.anchor) setInteraction(world, { mode: 'guide', x: action.anchor.x, y: action.anchor.y, strength: 0.4 });
  }
  // Master：每 4 bar 评估中度干扰目标。
  if (bar % 4 === 0) {
    const health = ecosystemHealth(world);
    const ops = masterPolicy(world, health, stagnation(world), masterCooldown);
    for (const op of ops) {
      if (op.type === 'spawn_pest_wave') { spawnPestWave(world, op.tree, op.intensity); masterCooldown = 8; }
      if (op.type === 'set_population') { for (let i = 0; i < Math.abs(op.delta); i += 1) op.delta > 0 ? addBoidLike(op.flock) : removeBoidLike(op.flock); }
      if (op.type === 'set_scale') setMasterChord(op.mode, false);
    }
    masterCooldown = Math.max(0, masterCooldown - 1);
  }
}

// ——— 音频启动 ———
audioButton.addEventListener('click', async () => {
  if (!audio.context) await audio.start(world.flocks); else await audio.toggle();
  if (audio.running && !scoreState.enabled) { scoreState.enabled = true; applyChord(); pushTransport(); }
  audioButton.textContent = audio.running ? '暂停声音' : '继续声音';
  audioButton.classList.toggle('running', audio.running);
  engineFact.textContent = '声音链：Web Audio 轻量合成器 · 4 树';
});

// ——— HUD ———
bpmSlider.addEventListener('input', () => setMasterTempo(Number(bpmSlider.value)));
chordQuality.addEventListener('change', () => setMasterChord(chordQuality.value));
document.querySelector('#master-release')?.addEventListener('click', () => { controlState.master = AGENT; masterBadge.textContent = '主脉 · 生态自持'; masterBadge.classList.remove('user'); });

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

// ——— 渲染 ———
function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize); resize();

// 美术素材（subagent 生成）：树贴图、鸟贴图、光点、虫斑、背景星云。
const sprites = {};
const SPRITE_SOURCES = {
  bg: './assets/sprites/bg-nebula.png',
  birdPerched: './assets/sprites/bird-perched.png',
  birdFlying: './assets/sprites/bird-flying.png',
  glow: './assets/sprites/glow-dot.png',
  pest: './assets/sprites/pest-speck.png',
  tree0: './assets/trees/tree-bass.png',
  tree1: './assets/trees/tree-support.png',
  tree2: './assets/trees/tree-ornament.png',
  tree3: './assets/trees/tree-shimmer.png',
};
for (const [key, src] of Object.entries(SPRITE_SOURCES)) {
  const img = new Image();
  img.src = src;
  sprites[key] = img;
}
const spriteReady = (key) => sprites[key]?.complete && sprites[key].naturalWidth > 0;

const SEASON_TINT = [[120, 0.10], [45, 0.12], [20, 0.12], [210, 0.16]]; // hue, sat
function draw() {
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  const dn = dayNightMacros(world.dayPhase);
  // 背景：星云贴图 + 昼夜/季节叠加。
  if (spriteReady('bg')) { ctx.globalAlpha = 0.5 + dn.daylight * 0.2; ctx.drawImage(sprites.bg, 0, 0, w, h); ctx.globalAlpha = 1; }
  const [sHue, sSat] = SEASON_TINT[world.season];
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${215 + sHue * 0.1} ${30 + sSat * 40}% ${4 + dn.daylight * 10}% / 0.82)`);
  g.addColorStop(1, `hsl(160 24% ${2 + dn.daylight * 6}% / 0.9)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.save();
  // camera 变换
  ctx.translate(w / 2, h / 2); ctx.scale(camera.scale, camera.scale); ctx.translate(-camera.cx * w, -camera.cy * h);
  const toPx = (nx, ny) => [nx * w, ny * h];
  // 四棵树
  for (const tree of world.trees) {
    const [tx, ty] = toPx(tree.slot.x, tree.slot.y);
    const cw = world.config.canopyWidth * w; const ch = world.config.canopyHeight * h;
    const fadeOthers = focusFlockId !== null && focusFlockId !== tree.id ? 1 - camera.u * 0.7 : 1;
    const treeImg = sprites[`tree${tree.id}`];
    const treeH = ch * 1.5; const treeW = treeH; // 贴图是正方形
    if (spriteReady(`tree${tree.id}`)) {
      ctx.save();
      ctx.globalAlpha = (0.35 + tree.foliage * 0.65) * fadeOthers;
      // 按色相上色：贴图是近白发光，用 hue 着色。
      ctx.filter = `hue-rotate(${tree.hue - 200}deg) saturate(${0.6 + tree.foliage * 0.6}) brightness(${0.7 + tree.foliage * 0.5})`;
      ctx.drawImage(treeImg, tx - treeW / 2, ty - treeH, treeW, treeH);
      ctx.restore();
    }
    // 栖点（下潜时显示，叠加在贴图枝干上）
    if (focusFlockId === tree.id && camera.u > 0.4) {
      for (const p of tree.branches) {
        const [x, y] = toPx(p.x, p.y);
        if (spriteReady('glow')) { ctx.globalAlpha = 0.3 * camera.u; ctx.drawImage(sprites.glow, x - 5, y - 5, 10, 10); ctx.globalAlpha = 1; }
        else { ctx.fillStyle = `hsla(${tree.hue} 70% 70% / ${0.25 * camera.u})`; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill(); }
      }
    }
    // 虫害斑点
    if (tree.pest > 0.03) {
      for (let i = 0; i < tree.pest * 10; i += 1) {
        const [x, y] = toPx(tree.slot.x + (Math.sin(i * 2.3 + tree.id) * 0.5) * 0.12, tree.slot.y - (0.15 + Math.abs(Math.sin(i * 1.7)) * 0.25));
        if (spriteReady('pest')) { ctx.globalAlpha = Math.min(0.8, tree.pest); ctx.drawImage(sprites.pest, x - 5, y - 5, 10, 10); ctx.globalAlpha = 1; }
        else { ctx.fillStyle = `hsla(15 60% 40% / ${Math.min(0.6, tree.pest)})`; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill(); }
      }
    }
    // 树名
    ctx.fillStyle = `hsla(${tree.hue} 60% 75% / ${0.85 * fadeOthers})`;
    ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${tree.treeName}·${tree.speciesName}`, tx, ty + 16);
  }
  // 扫描线（光）：横扫世界
  const [px] = toPx(world.pulsePosition, 0);
  const pg = ctx.createLinearGradient(px - 24, 0, px + 24, 0);
  pg.addColorStop(0, 'rgba(255,190,130,0)'); pg.addColorStop(0.5, `rgba(255,190,130,${0.35 * (1 - camera.u * 0.4)})`); pg.addColorStop(1, 'rgba(255,190,130,0)');
  ctx.fillStyle = pg; ctx.fillRect(px - 24, 0, 48, h);
  // 鸟（栖着=收翅贴图，飞着=展翅贴图）
  for (const boid of world.boids) {
    const flock = world.flocks[boid.flockId];
    const [x, y] = toPx(boid.x, boid.y);
    const isGuest = boid.perched && world.flocks[boid.flockId]?.homeTreeId !== boid.perched.treeId;
    const fade = focusFlockId !== null && focusFlockId !== flock.homeTreeId ? 1 - camera.u * 0.5 : 1;
    const img = boid.perched ? sprites.birdPerched : sprites.birdFlying;
    const size = (boid.perched ? 12 : 14) * (0.8 + camera.u * 0.5);
    ctx.save(); ctx.translate(x, y);
    if (spriteReady(boid.perched ? 'birdPerched' : 'birdFlying')) {
      ctx.globalAlpha = (isGuest ? 1 : 0.85) * fade;
      ctx.filter = `hue-rotate(${flock.hue - 200}deg) brightness(${isGuest ? 1.3 : 1})`;
      if (!boid.perched) ctx.rotate(Math.atan2(boid.vy, boid.vx));
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
    } else {
      ctx.fillStyle = `hsla(${flock.hue} 72% 72% / ${0.8 * fade})`;
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
    }
    ctx.restore();
    if (isGuest) { ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, size / 2 + 2, 0, TAU); ctx.stroke(); }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ——— 主循环 ———
let lastTime = performance.now();
let lastHud = 0;
function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000); lastTime = time;
  stepWorld(world, dt);
  stepCamera(dt);
  // transport 与 bar 边界
  if (scoreState.enabled) {
    world.pulsePosition = audio.transport ? audio.transport.beat / scoreState.loopBeats : world.pulsePosition;
    const bar = audio.transport ? Math.floor(audio.transport.beat / 4) : 0;
    if (bar !== scoreState.lastBar) {
      if (scoreState.lastBar >= 0) scoreState.absoluteBar += 1;
      runAgents(scoreState.absoluteBar);
      for (const command of drainAgentCommands(controlState, scoreState.absoluteBar)) executeAgentCommand(command);
    }
    scoreState.lastBar = bar;
    syncScoreToAudio();
  }
  audio.update(world);
  draw();
  if (time - lastHud > 300) { refreshHud(); lastHud = time; }
  requestAnimationFrame(frame);
}
applyChord();
requestAnimationFrame(frame);
window.latentCosmos = { exportSession: () => recorder.export(), world, audio, applyAgentCommand, controlState, camera, zoomInto, zoomOut, applySeason, spawnPestWave: (t, i) => spawnPestWave(world, t, i) };
