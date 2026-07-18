// 世界模型 v3：四棵树，一套鸟群。
// 树 = 乐器：枝干是和弦内音（高度∝音高），沿枝方向是 loop 的 16 步时间轴。
// 鸟 = 乐谱与音色：栖着的鸟决定音符存亡/力度/时值，飞着的鸟（光环）的 8D 关系决定音色。
// 这里只有生态状态与运动，没有「音」这个字——声音是映射层（eco/mapping.js）翻译的结果。

export const TAU = Math.PI * 2;
export const FIXED_DT = 1 / 200;
export const RELATION_DIMENSIONS = Object.freeze([
  'compactness',
  'alignment',
  'expansion',
  'motionEnergy',
  'circulation',
  'turbulence',
  'interFlockPressure',
  'obstaclePressure',
]);

// 四棵树：每个物种一个生态职能（设计 v3.3 §1）。
// 属性全部是生态词汇；声部接入是映射层的事。
export const SPECIES = Object.freeze([
  { id: 'pelican', name: '鹈鹕', treeName: '低吟树', role: 'bass', hue: 154, verb: '压枝', mass: 2.2, dwellBias: 0.92, speedScale: 0.55 },
  { id: 'dove', name: '斑鸠', treeName: '和鸣树', role: 'support', hue: 184, verb: '沃土', mass: 1.0, dwellBias: 0.6, speedScale: 0.8 },
  { id: 'lark', name: '百灵', treeName: '飞羽树', role: 'ornament', hue: 218, verb: '传粉', mass: 0.7, dwellBias: 0.3, speedScale: 1.25 },
  { id: 'woodpecker', name: '啄木鸟', treeName: '微光树', role: 'shimmer', hue: 268, verb: '啄虫', mass: 0.8, dwellBias: 0.18, speedScale: 1.1 },
]);

// 世界布局：四棵树在四角，中央留白。x/y 是归一化世界坐标。
export const TREE_SLOTS = Object.freeze([
  { x: 0.22, y: 0.7 },
  { x: 0.4, y: 0.24 },
  { x: 0.62, y: 0.24 },
  { x: 0.8, y: 0.7 },
]);

export const DEFAULT_CONFIG = Object.freeze({
  birdsPerFlock: 7,
  maxBirdsPerFlock: 20,
  tempo: 82,
  neighborRadius: 0.09,
  separationRadius: 0.03,
  maxSpeed: 0.1,
  maxForce: 0.3,
  cohesionStrength: 1,
  alignmentStrength: 1,
  separationStrength: 1,
  wanderStrength: 0.3,
  wanderRate: 0.15,
  // 栖落：鸟与栖点的吸引/驻留。
  perchAttractRadius: 0.05,   // 进入此范围开始被栖点捕获
  perchSnapRadius: 0.012,     // 小于此距离视为落稳
  dwellUrge: 0.5,             // 归栖倾向（0-1，agent/昼夜可调）
  // 枝干几何：每棵树冠的「卷帘」宽高。
  canopyWidth: 0.16,          // 世界坐标
  canopyHeight: 0.3,
  stepsPerLoop: 16,           // 16 步时间轴
  maxPerchBirds: 3,           // 同一栖点容量上限（力度三档）
});

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const wrap01 = (value) => ((value % 1) + 1) % 1;
const delta = (target, source) => ((target - source + 1.5) % 1) - 0.5;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

export function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function limit(x, y, maximum) {
  const magnitude = Math.hypot(x, y);
  return magnitude > maximum && magnitude > 0 ? [x / magnitude * maximum, y / magnitude * maximum] : [x, y];
}

// ——— 树与枝干 ———
// 枝干 = 和弦内音。chord 提供 rootMidi 与 intervals，band 是该声部音域带。
// 返回的每个栖点：{ branch, step, x, y, midi, beat }。x 沿枝=时间，y=音高。
export function buildTreeBranches(slot, chord, band, config) {
  const tones = [];
  for (let midi = Math.ceil(band.loMidi); midi <= Math.floor(band.hiMidi); midi += 1) {
    const pc = ((midi - chord.rootMidi) % 12 + 12) % 12;
    if (chord.intervals.includes(pc)) tones.push(midi);
  }
  if (!tones.length) tones.push(Math.round((band.loMidi + band.hiMidi) / 2));
  const branches = [];
  for (let b = 0; b < tones.length; b += 1) {
    const midi = tones[b];
    // 枝干在树冠中的高度：midi 越高枝干越高。留出主干余量。
    const yFrac = 1 - (midi - band.loMidi) / Math.max(1, band.hiMidi - band.loMidi);
    const y = slot.y - config.canopyHeight * (0.25 + yFrac * 0.75);
    for (let step = 0; step < config.stepsPerLoop; step += 1) {
      const xFrac = step / config.stepsPerLoop;
      branches.push({
        branch: b,
        step,
        midi,
        beat: xFrac * config.stepsPerLoop / 4, // 16 步 = 4 拍一个 loop 的 beat 坐标由外部定
        x: slot.x - config.canopyWidth / 2 + xFrac * config.canopyWidth,
        y,
      });
    }
  }
  return branches;
}

function createTree(id, species, slot, config) {
  return {
    id,
    speciesId: species.id,
    speciesName: species.name,
    treeName: species.treeName,
    role: species.role,
    hue: species.hue,
    slot: { ...slot },
    foliage: 0.8,   // 树健康（繁茂度）
    pest: 0,        // 虫害
    branches: [],   // 栖点集合（换和弦时重构）
  };
}

function createFlock(id, species) {
  return {
    id,
    speciesId: species.id,
    speciesName: species.name,
    role: species.role,
    hue: species.hue,
    homeTreeId: id,     // 初始一一对应
    energy: 0.7,
    dwellUrge: DEFAULT_CONFIG.dwellUrge,
    relationState: RELATION_DIMENSIONS.map(() => 0),
    relationTarget: RELATION_DIMENSIONS.map(() => 0),
    centroid: { x: 0.5, y: 0.5 },
    spread: 0,
    meanSpeed: 0,
    alignment: 0,
    expansion: 0,
    circulation: 0,
    turbulence: 0,
    pan: 0,
    population: 0,
    flyingCount: 0,
    perchedCount: 0,
    visitTreeId: null,   // 串门出诊的目标树（agent 设置），null = 守己树
  };
}

function makeBoid(world, flockId, x, y) {
  const angle = world.random() * TAU;
  const speed = world.config.maxSpeed * (0.4 + world.random() * 0.3);
  return {
    id: world.nextBoidId++,
    flockId,
    x: wrap01(x + (world.random() - 0.5) * 0.04),
    y: wrap01(y + (world.random() - 0.5) * 0.04),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    perched: null,      // null = 飞着；否则 { treeId, branch, step }
    dwell: 0,           // 当前驻留时长（秒）
    wanderPhase: world.random() * TAU,
    wanderOffset: world.random() * TAU,
  };
}

export function createWorld(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const seed = options.seed ?? 0xc05a05;
  const world = {
    schema: 6,
    seed,
    config,
    random: mulberry32(seed),
    nextBoidId: 1,
    trees: [],
    flocks: [],
    boids: [],
    tempo: config.tempo,
    pulsePosition: 0,   // 扫描线相位（0-1，loop 一圈）
    dayPhase: 0.3,      // 昼夜相位（0-1，0.25=正午 0.75=午夜）
    season: 0,          // 0-3
    dayLengthBeats: 16, // 一昼夜的拍数（master 可调）
    time: 0,
    accumulator: 0,
    interaction: null,
    metrics: { meanHealth: 0.8, maskingCost: 0, collectiveSpeed: 0 },
  };
  for (let id = 0; id < SPECIES.length; id += 1) {
    const species = SPECIES[id];
    world.trees.push(createTree(id, species, TREE_SLOTS[id], config));
    world.flocks.push(createFlock(id, species));
    const slot = TREE_SLOTS[id];
    for (let bird = 0; bird < config.birdsPerFlock; bird += 1) world.boids.push(makeBoid(world, id, slot.x, slot.y - config.canopyHeight * 0.5));
  }
  updateFlocks(world);
  return world;
}

// 换和弦 → 重构所有树的枝干（换季）。bandForRole(role) 返回 {loMidi, hiMidi}。
export function rebuildBranches(world, chord, bandForRole) {
  for (const tree of world.trees) {
    tree.branches = buildTreeBranches(tree.slot, chord, bandForRole(tree.role), world.config);
  }
  // 已栖的鸟就近换枝：清空栖息状态，让它们重新选择。
  for (const boid of world.boids) { boid.perched = null; boid.dwell = 0; }
}

// 收集当前乐谱：扫描线静止时各栖点的占用 → 音符事件。
// 返回每棵树（=声部）的音符数组 [{beat, midi, vel, dwellBeats, guest, count}]。
export function currentScore(world, loopBeats = 16) {
  const beatsPerStep = loopBeats / world.config.stepsPerLoop;
  return world.trees.map((tree) => {
    const notes = [];
    const byPerch = new Map();
    for (const boid of world.boids) {
      if (!boid.perched || boid.perched.treeId !== tree.id) continue;
      const key = `${boid.perched.branch}:${boid.perched.step}`;
      if (!byPerch.has(key)) byPerch.set(key, []);
      byPerch.get(key).push(boid);
    }
    for (const group of byPerch.values()) {
      const first = group[0];
      const perch = tree.branches.find((p) => p.branch === first.perched.branch && p.step === first.perched.step);
      if (!perch) continue;
      const guest = group.some((b) => world.flocks[b.flockId]?.homeTreeId !== tree.id);
      const maxDwell = Math.max(...group.map((b) => b.dwell));
      notes.push({
        beat: first.perched.step * beatsPerStep,
        midi: perch.midi,
        count: group.length,
        dwellBeats: maxDwell * (world.tempo / 60),
        guest,
        guestSpecies: guest ? world.flocks[group.find((b) => world.flocks[b.flockId]?.homeTreeId !== tree.id)?.flockId]?.speciesId : null,
      });
    }
    return notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  });
}

// 栖点占用表：treeId -> `${branch}:${step}` -> [boidId]
export function perchOccupancy(world) {
  const table = new Map();
  for (const boid of world.boids) {
    if (!boid.perched) continue;
    const key = `${boid.perched.treeId}:${boid.perched.branch}:${boid.perched.step}`;
    if (!table.has(key)) table.set(key, []);
    table.get(key).push(boid.id);
  }
  return table;
}

function nearestPerch(tree, x, y, config, occupancy, flockId, isGuest) {
  let best = null; let bestDistance = Infinity;
  for (const p of tree.branches) {
    const occupants = occupancy.get(`${tree.id}:${p.branch}:${p.step}`) ?? [];
    // 客鸟（串门出诊）不受容量限制——客音符是装饰层，host 满员也能落。
    if (!isGuest && occupants.length >= config.maxPerchBirds) continue;
    const d = Math.hypot(delta(p.x, x), delta(p.y, y));
    if (d < bestDistance) { bestDistance = d; best = p; }
  }
  return best ? { perch: best, distance: bestDistance } : null;
}

function stepBoid(world, previous, before, dt) {
  // 已栖的鸟：驻留计时，可能起飞。
  if (before.perched) {
    const flock = world.flocks[before.flockId];
    const tree = world.trees[before.perched.treeId];
    // 起飞概率：与栖息倾向（agent 旋钮）、体力、昼夜成反比。
    // 密度呼吸是 agent 的活（规则 2/3），物理层不强制。
    const daylight = 0.5 + 0.5 * Math.cos((world.dayPhase - 0.25) * TAU);
    const urgeToLeave = 0.4 + (1 - flock.dwellUrge) * (0.5 + daylight * 0.8) * (0.5 + flock.energy);
    if (world.random() < urgeToLeave * dt * 1.5) {
      return { ...before, perched: null, dwell: 0 };
    }
    return { ...before, dwell: before.dwell + dt, vx: 0, vy: 0 };
  }

  let alignX = 0; let alignY = 0; let cohesionX = 0; let cohesionY = 0; let neighborWeight = 0;
  let separateX = 0; let separateY = 0;
  for (const other of previous) {
    if (other.id === before.id || other.perched) continue;
    const dx = delta(other.x, before.x); const dy = delta(other.y, before.y);
    const distance = Math.hypot(dx, dy);
    if (distance > 0 && distance < world.config.separationRadius) {
      const pressure = (1 - distance / world.config.separationRadius) / Math.max(distance, 0.008);
      separateX -= dx * pressure; separateY -= dy * pressure;
    }
    if (other.flockId !== before.flockId || distance <= 0 || distance >= world.config.neighborRadius) continue;
    const weight = 1 - distance / world.config.neighborRadius;
    alignX += other.vx * weight; alignY += other.vy * weight;
    cohesionX += dx * weight; cohesionY += dy * weight;
    neighborWeight += weight;
  }
  let forceX = separateX * 0.022 * world.config.separationStrength;
  let forceY = separateY * 0.022 * world.config.separationStrength;
  if (neighborWeight > 0) {
    const aligned = limit(alignX / neighborWeight, alignY / neighborWeight, world.config.maxSpeed);
    forceX += (aligned[0] - before.vx) * 1.05 * world.config.alignmentStrength + cohesionX / neighborWeight * 0.42 * world.config.cohesionStrength;
    forceY += (aligned[1] - before.vy) * 1.05 * world.config.alignmentStrength + cohesionY / neighborWeight * 0.42 * world.config.cohesionStrength;
  }
  // 归树倾向：飞太远时向「目标树」回拉（默认己树；串门出诊时指向 host 树）。
  const flock = world.flocks[before.flockId];
  const targetTree = world.trees[flock.visitTreeId ?? flock.homeTreeId];
  const canopyY = targetTree.slot.y - world.config.canopyHeight * 0.5;
  const homeDx = delta(targetTree.slot.x, before.x);
  const homeDy = delta(canopyY, before.y);
  const homeDist = Math.hypot(homeDx, homeDy);
  if (homeDist > world.config.canopyWidth) {
    forceX += homeDx * 0.5; forceY += homeDy * 0.5;
  }
  // 归栖：根据 dwellUrge 被目标树的最近栖点捕获。
  const daylight = 0.5 + 0.5 * Math.cos((world.dayPhase - 0.25) * TAU);
  const perchDrive = flock.dwellUrge * (0.4 + (1 - daylight) * 0.6); // 夜里更想栖
  if (perchDrive > 0.05) {
    const occupancy = world._occupancy ?? (world._occupancy = perchOccupancy(world));
    const isGuest = (flock.visitTreeId ?? flock.homeTreeId) !== flock.homeTreeId;
    const found = nearestPerch(targetTree, before.x, before.y, world.config, occupancy, before.flockId, isGuest);
    if (found && found.distance < world.config.perchAttractRadius) {
      const p = found.perch;
      forceX += delta(p.x, before.x) * 3.0 * perchDrive;
      forceY += delta(p.y, before.y) * 3.0 * perchDrive;
      if (found.distance < world.config.perchSnapRadius) {
        return { ...before, x: p.x, y: p.y, vx: 0, vy: 0, perched: { treeId: targetTree.id, branch: p.branch, step: p.step }, dwell: 0 };
      }
    }
  }
  // 引导手势（用户聚鸟/赶鸟）。
  const interaction = world.interaction;
  if (interaction?.mode === 'guide') {
    const dx = delta(interaction.x, before.x); const dy = delta(interaction.y, before.y);
    const influence = Math.exp(-(dx * dx + dy * dy) / 0.045);
    forceX += dx * influence * 0.65; forceY += dy * influence * 0.65;
  }
  const wanderPhase = wrap01(before.wanderPhase / TAU + world.config.wanderRate * dt) * TAU;
  const wanderAngle = wanderPhase + Math.sin(wanderPhase * 0.37 + before.wanderOffset) * 1.7;
  const wanderForce = world.config.maxForce * world.config.wanderStrength * 0.22;
  forceX += Math.cos(wanderAngle) * wanderForce;
  forceY += Math.sin(wanderAngle) * wanderForce;
  const species = SPECIES.find((s) => s.id === flock.speciesId) ?? SPECIES[0];
  const boundedForce = limit(forceX, forceY, world.config.maxForce);
  const speedLimit = world.config.maxSpeed * species.speedScale;
  let vx = before.vx + boundedForce[0] * dt;
  let vy = before.vy + boundedForce[1] * dt;
  [vx, vy] = limit(vx, vy, speedLimit);
  return { ...before, x: wrap01(before.x + vx * dt), y: wrap01(before.y + vy * dt), vx, vy, wanderPhase };
}

function updateFlocks(world, dt = 0) {
  for (const flock of world.flocks) {
    const birds = world.boids.filter((boid) => boid.flockId === flock.id);
    flock.population = birds.length;
    if (!birds.length) continue;
    const flying = birds.filter((b) => !b.perched);
    flock.flyingCount = flying.length;
    flock.perchedCount = birds.length - flying.length;
    // 光环只用飞鸟计算（音色来自运动）。
    const movers = flying.length ? flying : birds;
    const reference = movers[0];
    const centroidX = wrap01(reference.x + mean(movers.map((b) => delta(b.x, reference.x))));
    const centroidY = wrap01(reference.y + mean(movers.map((b) => delta(b.y, reference.y))));
    const meanVx = mean(movers.map((b) => b.vx));
    const meanVy = mean(movers.map((b) => b.vy));
    const meanSpeed = mean(movers.map((b) => Math.hypot(b.vx, b.vy)));
    const spread = Math.sqrt(mean(movers.map((b) => delta(b.x, centroidX) ** 2 + delta(b.y, centroidY) ** 2)));
    const alignment = clamp(Math.hypot(meanVx, meanVy) / Math.max(meanSpeed, 1e-6));
    let radial = 0; let circulation = 0; let velocityVariance = 0;
    for (const bird of movers) {
      const rx = delta(bird.x, centroidX); const ry = delta(bird.y, centroidY);
      const radius = Math.hypot(rx, ry);
      const dvx = bird.vx - meanVx; const dvy = bird.vy - meanVy;
      if (radius > 1e-5) { radial += (rx * dvx + ry * dvy) / radius; circulation += (rx * dvy - ry * dvx) / radius; }
      velocityVariance += dvx * dvx + dvy * dvy;
    }
    const expansion = clamp(radial / movers.length / Math.max(world.config.maxSpeed, 1e-6), -1, 1);
    const circulationN = clamp(circulation / movers.length / Math.max(world.config.maxSpeed, 1e-6), -1, 1);
    const turbulence = clamp(Math.sqrt(velocityVariance / movers.length) / Math.max(world.config.maxSpeed, 1e-6));
    const compactness = clamp(1 - spread / Math.max(world.config.neighborRadius * 0.72, 1e-6));
    const motionEnergy = clamp(meanSpeed / Math.max(world.config.maxSpeed, 1e-6));
    const relationTarget = [compactness * 2 - 1, alignment * 2 - 1, expansion, motionEnergy * 2 - 1, circulationN, turbulence * 2 - 1, 0, 0];
    const smoothing = dt > 0 ? 1 - Math.exp(-dt * 4.5) : 1;
    flock.relationTarget = relationTarget;
    flock.relationState = flock.relationState.map((value, index) => value + (relationTarget[index] - value) * smoothing);
    flock.centroid = { x: centroidX, y: centroidY };
    flock.spread = spread;
    flock.meanSpeed = meanSpeed;
    flock.alignment = alignment;
    flock.expansion = expansion;
    flock.circulation = circulationN;
    flock.turbulence = turbulence;
    flock.pan += ((centroidX * 2 - 1) - flock.pan) * (dt > 0 ? 1 - Math.exp(-dt * 5) : 1);
    // 体力：飞耗能、栖回能、夜间回复加速。
    const daylight = 0.5 + 0.5 * Math.cos((world.dayPhase - 0.25) * TAU);
    const recovery = (flock.perchedCount / Math.max(1, flock.population)) * (0.4 + (1 - daylight) * 0.6);
    const drain = (flock.flyingCount / Math.max(1, flock.population)) * motionEnergy * 0.5;
    flock.energy = clamp(flock.energy + (recovery - drain) * dt * 0.2);
  }
}

import { stepEconomy } from './eco/economy.js';

function fixedStep(world, dt) {
  world._occupancy = null; // 本步缓存
  const previous = world.boids.map((boid) => ({ ...boid }));
  world.boids = previous.map((boid) => stepBoid(world, previous, boid, dt));
  updateFlocks(world, dt);
  // 树健康经济（五流量）。
  stepEconomy(world, dt);
  // 扫描线 = 一缕光扫过。tempo bpm → 一圈 = 4 拍 × loopBars（外部约定 loop 结构）。
  const beatsPerSecond = world.tempo / 60;
  world.pulsePosition = wrap01(world.pulsePosition + beatsPerSecond * dt / 4); // 4 拍一圈（默认 1 bar loop，外部可扩展）
  // 昼夜推进。
  world.dayPhase = wrap01(world.dayPhase + beatsPerSecond * dt / world.dayLengthBeats);
  world.time += dt;
}

export function stepWorld(world, rawDt) {
  world.accumulator += clamp(rawDt, 0, 0.1);
  while (world.accumulator + 1e-12 >= FIXED_DT) { fixedStep(world, FIXED_DT); world.accumulator -= FIXED_DT; }
  world.metrics = measureWorld(world);
  return world;
}

export function setInteraction(world, interaction) { world.interaction = interaction; }

export function addBoid(world, flockId, x, y) {
  const count = world.boids.filter((b) => b.flockId === flockId).length;
  if (!world.flocks.some((f) => f.id === flockId) || count >= world.config.maxBirdsPerFlock) return false;
  world.boids.push(makeBoid(world, flockId, x, y));
  updateFlocks(world);
  return true;
}

export function removeBoid(world, flockId) {
  const index = world.boids.findIndex((b) => b.flockId === flockId);
  if (index < 0) return false;
  const count = world.boids.filter((b) => b.flockId === flockId).length;
  if (count <= 1) return false;
  world.boids.splice(index, 1);
  updateFlocks(world);
  return true;
}

export function measureWorld(world) {
  const meanHealth = mean(world.trees.map((t) => t.foliage));
  const maskingCost = clamp(mean(world.trees.map((t) => t.pest)) * 1.2);
  return {
    meanHealth,
    maskingCost,
    collectiveSpeed: clamp(mean(world.flocks.map((f) => f.meanSpeed)) / Math.max(world.config.maxSpeed, 1e-6)),
  };
}

export function snapshotWorld(world) {
  return JSON.parse(JSON.stringify({
    schema: world.schema, seed: world.seed, tempo: world.tempo,
    pulsePosition: world.pulsePosition, dayPhase: world.dayPhase, season: world.season, time: world.time,
    trees: world.trees, flocks: world.flocks, boids: world.boids, metrics: world.metrics,
  }));
}
