// mvp/src/world.js —— 生态内核（事件驱动，Phase 3 四树版）。
// 词汇表里只有生态：树、枝、鸟、家枝、栖/飞、体力、昼夜相位。没有任何音乐概念。
//
// Phase 1.9（§3.5.3）：
//  - 双树等大并排（pad 树 + melody 树），两群鸟各归各树；一切 flock 状态按树分离。
//  - 音乐单位化：驻留=拍、活跃窗=小节，按 BPM 换算成秒执行（变速不改音乐行为）。
//  - melody 单音性：第二只鸟想落 melody 树时大概率被弹开继续飞（0.1 装饰双音）。
//  - 行为内核照旧：家枝/黎明归巢/驻留预算/换枝配额（全天本能，无作息）。
//
// 硬边界：
//  - 状态变化只发生在 world 内部；perch/unperch/dawn/dusk 都从这里显式 emit（带 treeId），
//    音频、日志等订阅者据此反应——禁止外部轮询推断状态变化。
//  - tick(dt) 由外部以固定步进驱动，与渲染帧解耦；rng 可注入（测试确定性）。

import { CONFIG } from './config.js';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// 相位约定：0=黎明 0.25=正午 0.5=黄昏 0.75=午夜。
export function daylightFromPhase(phase) {
  const t = ((phase % 1) + 1) % 1;
  return clamp(0.5 + 0.5 * Math.cos((t - 0.25) * Math.PI * 2));
}

export const beatsToSeconds = (beats, bpm) => beats * 60 / bpm;

// 驻留到期只能因果地向未来等待，不能回拨到已经过去的拍点。
// 返回 0 表示当前不在“下一拍前”的吸附窗内；飞行与落枝时间不作任何量化。
export function takeoffSnapDelaySeconds(simTime, bpm, windowBeats = 0.25) {
  const beatSeconds = 60 / Math.max(1, Number(bpm) || 60);
  const beat = Math.max(0, Number(simTime) || 0) / beatSeconds;
  const fraction = beat - Math.floor(beat);
  const forwardBeats = fraction < 1e-9 ? 0 : 1 - fraction;
  const window = clamp(Number(windowBeats) || 0, 0, 0.5);
  return forwardBeats > 0 && forwardBeats <= window ? forwardBeats * beatSeconds : 0;
}

export function snapDwellDurationSeconds(startTime, duration, bpm, windowBeats = 0.25) {
  const rawDuration = Math.max(0, Number(duration) || 0);
  const beatSeconds = 60 / Math.max(1, Number(bpm) || 60);
  const expiryBeats = (Math.max(0, Number(startTime) || 0) + rawDuration) / beatSeconds;
  const nearestBeat = Math.round(expiryBeats);
  const deltaBeats = nearestBeat - expiryBeats;
  const window = clamp(Number(windowBeats) || 0, 0, 0.5);
  if (Math.abs(deltaBeats) > window) return rawDuration;
  return Math.max(0, rawDuration + deltaBeats * beatSeconds);
}

/**
 * 按权重抽下标（恰好一次 rng）。全 1 权重时与 Math.floor(rng()*n) 精确等价（含 rng()*n 为整数的边界）。
 * 全 0 权重时均匀兜底。终止条件 r < 0（非 <=）。
 */
export function pickIndexByWeights(weights, rngFn = Math.random) {
  const raw = weights.map((w) => Math.max(0, Number(w) || 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? raw : raw.map(() => 1);
  const total = sum > 0 ? sum : w.length;
  let r = rngFn() * total;
  for (let i = 0; i < w.length; i += 1) {
    r -= w[i];
    if (r < 0) return i;
  }
  return w.length - 1;
}

// 档位按每树真实可参与容量比例化，避免小鸟群的 normal/full 都被同一 birdCount
// 截断而成为不可达空档。仍兼容调用方注入的旧绝对人数表（值 > 1）。
export function densitySizeForTier(tier, birdCount, capacity = birdCount, tiers = CONFIG.agent.densityTiers) {
  const reachable = Math.max(0, Math.min(
    Math.floor(Number(birdCount) || 0),
    Math.floor(Number(capacity) || 0),
  ));
  const configured = Number(tiers?.[tier]);
  if (!Number.isFinite(configured) || configured < 0) return 0;
  if (configured > 1) return Math.min(reachable, Math.floor(configured));
  if (tier === 'full') return reachable;
  const size = tier === 'sparse'
    ? Math.floor(reachable * configured)
    : Math.round(reachable * configured);
  const minimum = reachable > 0 ? 1 : 0;
  return Math.max(minimum, Math.min(reachable, size));
}

export function createWorld({ config = CONFIG, rng = Math.random } = {}) {
  const cfg = config;
  const listeners = new Map(); // event -> Set<fn>

  // ---- 枝干几何（纵向枝 + 可选横向 runner；渲染用镜像/缩放做差异）----
  const trunkTop = { x: 0, y: cfg.tree.trunkHeight };
  const verticalBranchCount = cfg.tree.branches.length;

  function buildRunnerNodes(startId) {
    const runners = Array.isArray(cfg.tree.runners) ? cfg.tree.runners : [];
    const nodes = [];
    let nextId = startId;
    for (const runner of runners) {
      const count = Math.max(1, Math.floor(Number(runner.nodeCount) || 1));
      const span = cfg.tree.trunkHeight * (Number(runner.span) || 0.7);
      const y = cfg.tree.trunkHeight * (Number(runner.attach) || 0.4);
      const x0 = (Number(runner.xCenter) || 0) - span / 2;
      for (let i = 0; i < count; i += 1) {
        const x = count === 1 ? (Number(runner.xCenter) || 0) : x0 + (span * i) / (count - 1);
        const point = { x, y };
        nodes.push({
          id: nextId,
          isRunner: true,
          runnerId: Number.isInteger(runner.id) ? runner.id : 0,
          nodeIndex: i,
          nodeCount: count,
          base: { ...point },
          tip: { ...point },
          slots: [{ ...point }],
        });
        nextId += 1;
      }
    }
    return nodes;
  }

  function buildBranches(treeCfg) {
    const vertical = cfg.tree.branches.map((b) => {
      const rad = (b.angle * Math.PI) / 180;
      const base = { x: 0, y: cfg.tree.trunkHeight * b.attach };
      const len = cfg.tree.trunkHeight * b.length;
      const tip = { x: base.x + Math.sin(rad) * len, y: base.y + Math.cos(rad) * len };
      const slots = [];
      for (let i = 0; i < cfg.tree.perchSlotsPerBranch; i += 1) {
        const t = cfg.tree.slotStart + i * cfg.tree.slotSpacing;
        slots.push({ x: base.x + (tip.x - base.x) * t, y: base.y + (tip.y - base.y) * t });
      }
      return {
        id: b.id, isRunner: false, runnerId: null, nodeIndex: null, nodeCount: null, base, tip, slots,
      };
    });
    const sp = cfg.species[treeCfg.species];
    if (!sp?.useRunners) return vertical;
    return [...vertical, ...buildRunnerNodes(verticalBranchCount)];
  }

  // ---- 全局时钟状态 ----
  const state = {
    simTime: 0,
    day: 1,
    phase: cfg.sim.startPhase,
    bpm: cfg.tempo.defaultBpm,
    dayLength: cfg.tempo.barsPerDay * cfg.tempo.beatsPerBar * 60 / cfg.tempo.defaultBpm,
    daylight: daylightFromPhase(cfg.sim.startPhase),
  };
  const secondsPerBeat = () => 60 / state.bpm;
  const barPos = () => state.phase * cfg.tempo.barsPerDay; // 当前在第几小节（0..bars）

  // ---- 四树（flock 状态按树分离；bass 可挂横向 runner 槽）----
  const trees = cfg.trees.map((t, ti) => ({
    id: t.id,
    index: ti,
    xOffset: t.xOffset,
    mirror: t.mirror,
    drawScale: t.drawScale,
    registerOffset: t.registerOffset,
    speciesName: t.species,
    branches: buildBranches(t),
    birds: [],
    densityTier: cfg.agent.defaultDensityTier,
    dwellBeats: cfg.species[t.species].dwellBeats, // 日界计划可调（拍）
    activeBars: cfg.tempo.barsPerDay,              // 日界计划可调（小节/天）
    lastSeasonMigrationDay: null,
    stats: null,
  }));
  const speciesOf = (tree) => cfg.species[tree.speciesName];
  const branchCountOf = (tree) => tree.branches.length;
  const branchById = (tree, branchId) => tree.branches.find((b) => b.id === branchId) ?? null;
  const branchIdsFor = (tree) => {
    const allowed = speciesOf(tree).allowedBranches;
    const maxId = Math.max(-1, ...tree.branches.map((b) => b.id));
    if (!Array.isArray(allowed) || !allowed.length) return tree.branches.map((b) => b.id);
    return allowed.filter((id) => Number.isInteger(id) && id >= 0 && id <= maxId
      && tree.branches.some((b) => b.id === id));
  };
  const branchAllowed = (tree, branchId) => branchIdsFor(tree).includes(branchId);

  // 每树「枝偏好权重」：上游写入的纯 0..1 数字数组，缺省全 1。
  // world 不做语义解释，只按数值加权抽样。长度=该树 branch 槽数（含 runner）。
  const branchPreference = Object.fromEntries(
    trees.map((t) => [t.id, new Array(branchCountOf(t)).fill(1)]),
  );
  // 每树「发声偏置」：上游写入的纯 0..1 标量，缺省 1（不抑制换枝）。
  // <1 时按概率推迟 hop——world 只看数值，不懂声部/错峰语义。
  const vocalizeBias = Object.fromEntries(trees.map((t) => [t.id, 1]));

  /** @returns {boolean} 未知 treeId 时 false */
  function setBranchPreference(treeId, weights) {
    if (!(treeId in branchPreference)) return false;
    const tree = trees.find((t) => t.id === treeId);
    const n = branchCountOf(tree);
    const next = new Array(n).fill(1);
    if (Array.isArray(weights)) {
      for (let i = 0; i < n; i += 1) {
        const raw = Number(weights[i]);
        next[i] = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
      }
    }
    branchPreference[treeId] = next;
    return true;
  }

  function getBranchPreference(treeId) {
    const w = branchPreference[treeId];
    return w ? w.slice() : null;
  }

  /** @returns {boolean} 未知 treeId 时 false */
  function setVocalizeBias(treeId, bias) {
    if (!(treeId in vocalizeBias)) return false;
    const raw = Number(bias);
    vocalizeBias[treeId] = Number.isFinite(raw) ? clamp(raw, 0, 1) : 1;
    return true;
  }

  function getVocalizeBias(treeId) {
    return treeId in vocalizeBias ? vocalizeBias[treeId] : null;
  }

  /**
   * 在已过滤的候选枝上按偏好权重加权抽样（恰好一次 rng；全 1 时 ≡ Math.floor(rng()*n)）。
   * 正权候选优先；若全部为 0 权仍有空位 → 均匀兜底。
   */
  function pickByPreference(tree, candidates, referenceBranch = null) {
    if (!candidates.length) return null;
    const prefs = branchPreference[tree.id];
    const positive = candidates.filter((id) => (prefs[id] ?? 1) > 0);
    const pool = positive.length > 0 ? positive : candidates;
    const stepPreference = clamp(Number(speciesOf(tree).stepPreference) || 0, 0, 1);
    // 枝 id 按物理高度升序；这里只按 id 距离表达“邻枝”本能，不读取音高。
    // p=0 时 factor 恒 1，候选池、权重和单次 rng 调用与旧实现逐 tick 等价。
    const weights = pool.map((id) => {
      const base = prefs[id] ?? 1;
      if (stepPreference <= 0 || !Number.isInteger(referenceBranch)) return base;
      const distance = Math.max(1, Math.abs(id - referenceBranch));
      // 平方衰减让 0.7 在五枝空间里足够可听，同时仍保留远枝小概率。
      const stepFactor = (1 - stepPreference) + stepPreference / (distance ** 2);
      return base * stepFactor;
    });
    const idx = pickIndexByWeights(weights, rng);
    return pool[idx];
  }

  function resetStats(tree) {
    tree.stats = {
      switches: 0,
      perBirdSwitches: {},
      dwellSamples: [],
      dwellBeatSamples: [],
      silentTime: 0,
      dayTime: 0,
    };
  }
  for (const t of trees) resetStats(t);

  const inActivityWindow = (tree) => {
    if (barPos() >= tree.activeBars) return false;
    return speciesOf(tree).activityBars.some(([a, b]) => barPos() >= a && barPos() < b);
  };

  // ---- 鸟（全局唯一 id，各自归属一棵树）----
  const birds = [];
  for (const tree of trees) {
    for (let i = 0; i < cfg.trees[tree.index].birdCount; i += 1) {
      const bird = {
        id: birds.length,
        treeId: tree.id,
        state: 'flying', // 'flying' | 'perched'
        branchId: null,
        slotIndex: null,
        homeBranch: branchIdsFor(tree)[Math.floor(rng() * branchIdsFor(tree).length)],
        activeToday: false,
        mode: 'settle',       // 'settle' 归巢 | 'day' 日内 | 'free' 游离
        targetBranch: null,
        settleAt: 0,
        plannedDwell: 0,      // 秒（由拍预算换算）
        plannedFlight: 0,
        switchesUsed: 0,
        lastBranch: null,
        returnBranch: null,   // texture 自主起飞后一次性“下次落回”候选
        returnCause: null,
        returnSequence: 0,
        visitCounts: new Array(branchCountOf(tree)).fill(0),
        energy: cfg.birds.energyStartMin + rng() * cfg.birds.energyStartSpan,
        dwellTime: 0,
        dwellBeatTime: 0,
        flightTime: 0,
        orbitRadius: cfg.birds.orbitRadiusMin + rng() * cfg.birds.orbitRadiusSpan,
        orbitAngle: rng() * Math.PI * 2,
        orbitSpeed: cfg.birds.orbitAngularSpeed * (1 - cfg.birds.orbitSpeedJitter / 2 + rng() * cfg.birds.orbitSpeedJitter),
        bobPhase: rng() * Math.PI * 2,
        pos: { x: tree.xOffset, y: 0 },
      };
      tree.birds.push(bird);
      birds.push(bird);
    }
  }
  const treeOf = (bird) => trees.find((t) => t.id === bird.treeId);

  // ---- 事件总线 ----
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }
  function emit(event, payload) {
    const subs = listeners.get(event);
    if (subs) for (const fn of [...subs]) fn(payload);
    const any = listeners.get('*');
    if (any) for (const fn of [...any]) fn({ event, ...payload });
  }

  // ---- 栖/飞转换：事件的唯一发源地 ----
  function countOnBranch(tree, branchId) {
    return tree.birds.filter((b) => b.state === 'perched' && b.branchId === branchId).length;
  }
  const perchedOnTree = (tree) => tree.birds.filter((b) => b.state === 'perched').length;
  const perchedTotal = () => birds.filter((b) => b.state === 'perched').length;

  // Phase 4：每树 AGENT/USER（运行时）。写入方约定=main syncControlWithFocus（zoom 进出）；
  // agent 只读 getTreeControl 跳过计划，不得主动重置用户家枝/栖位。
  const treeControl = Object.fromEntries(trees.map((t) => [t.id, 'AGENT']));
  function setTreeControl(treeId, mode) {
    if (!(treeId in treeControl)) return false;
    treeControl[treeId] = mode === 'USER' ? 'USER' : 'AGENT';
    return true;
  }
  function getTreeControl(treeId) {
    return treeControl[treeId] ?? 'AGENT';
  }
  function isUserTree(tree) {
    return getTreeControl(tree.id) === 'USER';
  }

  function landOn(bird, branchId, cause) {
    const tree = treeOf(bird);
    const branch = branchById(tree, branchId);
    if (!branch) return;
    // 先读取已有占位数；若先把当前鸟标为 perched，首个槽位会错误地从 1 开始。
    const slotIndex = countOnBranch(tree, branchId) % branch.slots.length;
    const returnedToLastBranch = bird.returnBranch !== null && branchId === bird.returnBranch;
    bird.state = 'perched';
    bird.branchId = branchId;
    bird.slotIndex = slotIndex;
    bird.dwellTime = 0;
    bird.dwellBeatTime = 0;
    bird.returnBranch = null; // 无论偏置成功或因占位回落，下一次落枝都消费本次抽签
    bird.returnCause = null;
    const visitIdx = tree.branches.findIndex((b) => b.id === branchId);
    if (visitIdx >= 0) bird.visitCounts[visitIdx] += 1;
    const slot = branch.slots[bird.slotIndex];
    bird.pos = { x: tree.xOffset + slot.x, y: slot.y };
    if (cause === 'hop' && bird.lastBranch !== null && bird.lastBranch !== branchId) {
      bird.switchesUsed += 1; // 日内换枝才消耗配额；归巢/迈步不算
      tree.stats.switches += 1;
      tree.stats.perBirdSwitches[bird.id] = (tree.stats.perBirdSwitches[bird.id] ?? 0) + 1;
    }
    emit('perch', {
      birdId: bird.id,
      treeId: tree.id,
      branchId,
      cause,
      returnedToLastBranch,
      isRunner: !!branch.isRunner,
      runnerId: branch.runnerId,
      nodeIndex: branch.nodeIndex,
      perchedOnBranch: countOnBranch(tree, branchId),
      perchedOnTree: perchedOnTree(tree),
      phase: state.phase,
      day: state.day,
      time: state.simTime,
    });
  }

  function launch(bird, cause) {
    const tree = treeOf(bird);
    const branchId = bird.branchId;
    const dwellTime = bird.dwellTime;
    const dwellBeats = bird.dwellBeatTime;
    const returnProbability = speciesOf(tree).returnBranchProbability;
    // 自主起飞统一登记候选；后续无论进入 hop 还是黎明 settle，都由落枝选择消费。
    // manual 是用户明确指定的起落，不让物种性格改写交互意图。
    bird.returnBranch = returnProbability > 0 && cause !== 'manual' && branchId !== null ? branchId : null;
    bird.returnCause = bird.returnBranch === null ? null : cause;
    bird.state = 'flying';
    bird.lastBranch = branchId;
    bird.branchId = null;
    bird.slotIndex = null;
    bird.flightTime = 0;
    // 驻留样本口径（与 economy 统一，T40）：日内 hop|user|walk 且 dwell>0；
    // settle/manual 归巢长窝不计。日终仍栖开放样本见 finalizeDayStats。
    // walk 计入：横向迈步的节点驻留=乐句片段，供 meanDwell 观测。
    if ((cause === 'hop' || cause === 'user' || cause === 'walk') && dwellTime > 0) {
      tree.stats.dwellSamples.push(dwellTime);
      tree.stats.dwellBeatSamples.push(dwellBeats);
    }
    emit('unperch', {
      birdId: bird.id,
      treeId: tree.id,
      branchId,
      cause,
      dwellTime,
      dwellBeats,
      phase: state.phase,
      day: state.day,
      time: state.simTime,
    });
  }

  // 手动 API（测试/未来交互用）：守卫保证不重复发事件（旁路单音性，文档注明）
  function perchBird(birdId, branchId) {
    const bird = birds[birdId];
    if (!bird || bird.state === 'perched') return false;
    const tree = treeOf(bird);
    if (!branchById(tree, branchId) || !branchAllowed(tree, branchId)) return false;
    landOn(bird, branchId, 'manual');
    return true;
  }
  function unperchBird(birdId) {
    const bird = birds[birdId];
    if (!bird || bird.state !== 'perched') return false;
    launch(bird, 'manual');
    return true;
  }

  // Phase 4 user 事件源：cause:'user' 走同一 perch/unperch 路径（无豁免）。
  // 空位：flying 优先，否则挪他枝鸟。满员：先踢目标枝驻留最久者腾位，再落选中鸟（不超员）。
  function userPlaceOnBranch(treeId, branchId) {
    const tree = trees.find((t) => t.id === treeId);
    if (!tree || !Number.isInteger(branchId) || !branchById(tree, branchId)) return null;
    if (!branchAllowed(tree, branchId)) return null;
    const sp = speciesOf(tree);
    const capacity = sp.maxCohortPerBranch;

    // 满员先腾位：踢走该枝 dwell 最长者（平手取较小 id），其 dwell 经 unperch 出账；新鸟 landOn 清零。
    let evictedId = null;
    if (countOnBranch(tree, branchId) >= capacity) {
      const victim = [...tree.birds]
        .filter((b) => b.state === 'perched' && b.branchId === branchId)
        .sort((a, b) => (b.dwellTime - a.dwellTime) || (a.id - b.id))[0];
      if (!victim) return null;
      launch(victim, 'user');
      victim.mode = 'free';
      victim.plannedFlight = Infinity;
      victim.targetBranch = null;
      evictedId = victim.id;
    }

    // 选鸟：优先其他 flying，其次他枝 perched；仅当无替代时才复用刚踢走的 flying。
    let bird = tree.birds.find((b) => b.state === 'flying' && b.id !== evictedId)
      ?? tree.birds.find((b) => b.state === 'perched' && b.branchId !== branchId)
      ?? tree.birds.find((b) => b.state === 'flying');
    if (!bird) return null;
    if (bird.state === 'perched') {
      if (bird.branchId === branchId) {
        return { birdId: bird.id, branchId, replaced: false, same: true, evictedId: null };
      }
      launch(bird, 'user');
    }
    landOn(bird, branchId, 'user');
    bird.homeBranch = branchId;
    bird.mode = 'day';
    bird.activeToday = true;
    bird.plannedDwell = Infinity; // USER 接管：驻到用户赶走
    bird.targetBranch = branchId;
    return {
      birdId: bird.id,
      branchId,
      replaced: evictedId != null,
      same: false,
      evictedId,
    };
  }

  function userShooBird(birdId) {
    const bird = birds[birdId];
    if (!bird || bird.state !== 'perched') return false;
    launch(bird, 'user');
    bird.mode = 'free';
    bird.plannedFlight = Infinity;
    bird.targetBranch = null;
    return true;
  }

  // ---- 驻留/飞行预算（拍 → 秒，本能物理）----
  const drawDwell = (tree) => {
    const natural = tree.dwellBeats * secondsPerBeat()
      * (1 - speciesOf(tree).dwellJitter / 2 + rng() * speciesOf(tree).dwellJitter);
    // 预算在生成时即把“到期点”吸到最近拍点；最多前后 windowBeats，因而
    // behaviorStep 真正决定起飞时已经站在拍点上。飞行和落枝预算仍原样随机。
    return snapDwellDurationSeconds(
      state.simTime, natural, state.bpm, cfg.dayCycle.takeoffSnapWindowBeats,
    );
  };
  const drawFlight = () => cfg.birds.flightBaseSeconds * (1 - cfg.birds.flightJitter / 2 + rng() * cfg.birds.flightJitter);

  // 选枝（归巢/无空位兜底）：候选枝 = 有群聚空位的枝；负载最轻者中按偏好权重抽样
  function leastLoadedWithRoom(tree, candidates, referenceBranch = null) {
    const sp = speciesOf(tree);
    const withRoom = candidates.filter((id) => branchAllowed(tree, id)
      && countOnBranch(tree, id) < sp.maxCohortPerBranch);
    if (!withRoom.length) return null;
    const loads = withRoom.map((id) => countOnBranch(tree, id));
    const min = Math.min(...loads);
    const best = withRoom.filter((_, i) => loads[i] === min);
    return pickByPreference(tree, best, referenceBranch);
  }

  function preferredReturnBranch(bird) {
    if (bird.returnBranch === null) return null;
    const tree = treeOf(bird);
    const sp = speciesOf(tree);
    if (!branchAllowed(tree, bird.returnBranch)
      || countOnBranch(tree, bird.returnBranch) >= sp.maxCohortPerBranch) return null;
    // hop 保持原实现的共享 rng 抽签时点，避免改变其他树的确定性序列；新增的
    // settle 路径用逐鸟序列，防止黎明多一次抽签污染跨树共享随机流。
    let roll;
    if (bird.returnCause === 'hop') {
      roll = rng();
    } else {
      bird.returnSequence += 1;
      const wave = Math.sin((bird.id + 1) * 12.9898 + bird.returnSequence * 78.233) * 43758.5453;
      roll = wave - Math.floor(wave);
    }
    return roll < sp.returnBranchProbability ? bird.returnBranch : null;
  }

  function visitCountOf(bird, tree, branchId) {
    const idx = tree.branches.findIndex((b) => b.id === branchId);
    return idx >= 0 ? (bird.visitCounts[idx] ?? 0) : 0;
  }

  // 换枝选枝（hop）：排除当前枝，偏向今日到访最少的枝；平手按偏好权重抽样
  function pickHopBranch(bird) {
    const tree = treeOf(bird);
    const sp = speciesOf(tree);
    const withRoom = branchIdsFor(tree)
      .filter((id) => id !== bird.branchId && countOnBranch(tree, id) < sp.maxCohortPerBranch);
    if (!withRoom.length) return null;
    const minVisit = Math.min(...withRoom.map((id) => visitCountOf(bird, tree, id)));
    const best = withRoom.filter((id) => visitCountOf(bird, tree, id) === minVisit);
    return pickByPreference(tree, best, bird.branchId);
  }

  // C2：横向 runner 邻节点迈步——只看形态邻接（nodeIndex±1），不引入网格时钟。
  function pickWalkBranch(bird) {
    const tree = treeOf(bird);
    const current = branchById(tree, bird.branchId);
    if (!current?.isRunner) return null;
    const sp = speciesOf(tree);
    const neighbors = tree.branches.filter((b) => b.isRunner
      && b.runnerId === current.runnerId
      && Math.abs(b.nodeIndex - current.nodeIndex) === 1
      && branchAllowed(tree, b.id)
      && countOnBranch(tree, b.id) < sp.maxCohortPerBranch).map((b) => b.id);
    if (!neighbors.length) return null;
    return pickByPreference(tree, neighbors, bird.branchId);
  }

  // 单音性（§3.5.3.2）：落 melody 树且树上已有人时，大概率被弹开继续飞。
  // 返回 true = 允许落。仅对物种带 monophonyBounceProb 的树生效；装饰最多双音。
  function monophonyAllows(tree) {
    const bounceProb = speciesOf(tree).monophonyBounceProb;
    if (!bounceProb) return true;
    const perched = perchedOnTree(tree);
    if (perched === 0) return true;      // 空树随便落
    if (perched >= 2) return false;      // 双音已是装饰上限，三重弹开
    return rng() >= bounceProb;          // 0.1 装饰双音
  }

  // ---- 黎明前置钩子：换和弦/家枝迁移/日界计划生效（必须在归巢规划之前）----
  const beforeDawnHooks = new Set();
  function onBeforeDawn(fn) {
    beforeDawnHooks.add(fn);
    return () => beforeDawnHooks.delete(fn);
  }

  // 日终统计：每树一份（黎明→黎明的完整数据）
  // 驻留口径（与 economy.finishDay 统一，T40）：
  // meanDwellBeats = 日内 hop|user 离枝样本 + 日终仍栖开放样本 的算术平均（拍）。
  // 开放样本用当日累计 dwellBeatTime（日界后清零，避免跨日滚到 125 拍假「偏长」）。
  function finalizeDayStats(day) {
    const perTree = {};
    for (const tree of trees) {
      for (const bird of tree.birds) {
        if (bird.state === 'perched' && bird.dwellBeatTime > 0) {
          tree.stats.dwellSamples.push(bird.dwellTime);
          tree.stats.dwellBeatSamples.push(bird.dwellBeatTime);
        }
      }
      const loads = tree.branches.map((br) => tree.birds.filter(
        (b) => (b.state === 'perched' ? b.branchId : (b.targetBranch ?? b.homeBranch)) === br.id,
      ).length);
      const active = tree.birds.filter((b) => b.activeToday);
      const meanDwell = tree.stats.dwellSamples.length
        ? tree.stats.dwellSamples.reduce((s, v) => s + v, 0) / tree.stats.dwellSamples.length
        : 0;
      const meanDwellBeats = tree.stats.dwellBeatSamples.length
        ? tree.stats.dwellBeatSamples.reduce((sum, value) => sum + value, 0) / tree.stats.dwellBeatSamples.length
        : 0;
      perTree[tree.id] = {
        day,
        species: tree.speciesName,
        branchLoads: loads,
        switches: tree.stats.switches,
        perBirdSwitches: { ...tree.stats.perBirdSwitches },
        meanDwell,
        meanDwellBeats,
        dwellSampleCount: tree.stats.dwellSamples.length,
        activeCount: active.length,
        birdCount: tree.birds.length,
        silentRatio: tree.stats.dayTime > 0 ? tree.stats.silentTime / tree.stats.dayTime : 0,
        switchRate: tree.stats.switches / Math.max(1, active.length),
        densityTier: tree.densityTier,
        dwellBeats: tree.dwellBeats,
        activeBars: tree.activeBars,
      };
    }
    return { day, trees: perTree };
  }

  // ---- 黎明：日终统计 → 前置钩子 → 归巢规划 → 事件 ----
  function onDawn() {
    const endedStats = finalizeDayStats(state.day);
    state.day += 1;
    for (const t of trees) resetStats(t);
    // 日界清零仍栖鸟的驻留累计，保证次日开放样本只含「本日」连续栖枝（T40 P0-3）。
    for (const bird of birds) {
      if (bird.state === 'perched') {
        bird.dwellTime = 0;
        bird.dwellBeatTime = 0;
      }
    }
    for (const fn of [...beforeDawnHooks]) fn({ day: state.day, stats: endedStats });
    for (const tree of trees) {
      // USER 接管：跳过黎明归巢规划，保留用户摆的栖位；仍清换枝计数以便日统计。
      if (isUserTree(tree)) {
        for (const bird of tree.birds) {
          bird.switchesUsed = 0;
          bird.visitCounts.fill(0);
          if (bird.state === 'perched') {
            bird.mode = 'day';
            bird.activeToday = true;
            bird.plannedDwell = Infinity;
          }
        }
        continue;
      }
      const sp = speciesOf(tree);
      // 参与今日 pattern 的鸟数：密度档位为上限；爱换枝的物种须留出空位才能起跳
      const perchCapacity = sp.maxCohortPerBranch * branchIdsFor(tree).length;
      const hopRoom = sp.switchQuota > 0 ? 1 : 0;
      const baseSize = densitySizeForTier(
        tree.densityTier,
        tree.birds.length,
        perchCapacity - hopRoom,
        cfg.agent.densityTiers,
      );
      // 发声偏置缩放参与人数（0..1）：抑制树少鸟栖 → 跨声部留白；缺省 1 ≡ 旧行为。
      const bias = vocalizeBias[tree.id] ?? 1;
      const patternSize = Math.max(0, Math.round(baseSize * bias));
      // 活跃集合尽量继承昨天，只补/退差额（循环继承性也体现在成员稳定）
      let active = tree.birds.filter((b) => b.activeToday).map((b) => b.id);
      while (active.length > patternSize) {
        const drop = Math.floor(rng() * active.length);
        birds[active[drop]].activeToday = false;
        active.splice(drop, 1);
      }
      while (active.length < patternSize) {
        const idle = tree.birds.filter((b) => !b.activeToday);
        if (!idle.length) break;
        const pick = idle[Math.floor(rng() * idle.length)];
        pick.activeToday = true;
        active.push(pick.id);
      }
      for (const bird of tree.birds) {
        bird.switchesUsed = 0;
        bird.visitCounts.fill(0);
        bird.settleAt = state.simTime + rng() * cfg.dayCycle.settleBeats * secondsPerBeat();
        if (bird.activeToday) {
          // 恋枝性：概率返回家枝；否则按枝偏好权重漂到别的枝（缺省全 1 ≡ 均匀）
          bird.targetBranch = rng() < sp.fidelity
            ? bird.homeBranch
            : pickByPreference(tree, branchIdsFor(tree), bird.branchId ?? bird.lastBranch);
          bird.mode = 'settle';
          if (bird.state === 'flying') bird.plannedFlight = drawFlight(); // 游离归来给落地时限
        } else {
          bird.mode = 'free'; // 不参与今日 pattern：起飞游离（沉默）
          bird.targetBranch = null;
        }
      }
    }
    emit('dawn', { day: state.day, phase: state.phase, time: state.simTime, stats: endedStats });
  }

  // ---- 黄昏：纯视觉/日志节点（无作息，夜里照样演奏）----
  function onDusk() {
    emit('dusk', { day: state.day, phase: state.phase, time: state.simTime });
  }

  // ---- 日内行为内核：只剩本能物理（全天按物种性格演奏）----
  function behaviorStep() {
    for (const bird of birds) {
      const tree = treeOf(bird);
      // USER 接管：冻结自主换枝/归巢，只保留用户摆放；生理（能量/驻留累计）仍走 physiologyStep。
      if (isUserTree(tree)) continue;
      if (bird.mode === 'free') {
        if (bird.state === 'perched' && state.simTime >= bird.settleAt) {
          launch(bird, 'settle');
          bird.plannedFlight = Infinity; // 全天滑翔
        }
        continue;
      }
      if (bird.mode === 'settle') {
        if (state.simTime < bird.settleAt) continue;
        if (bird.state === 'perched') {
          if (bird.branchId === bird.targetBranch) {
            bird.mode = 'day'; // 已在家枝上：静默续栖，pattern 与昨天同
            bird.plannedDwell = drawDwell(tree);
          } else {
            launch(bird, 'settle');
            bird.plannedFlight = drawFlight();
          }
        } else if (bird.flightTime >= bird.plannedFlight) {
          let target = preferredReturnBranch(bird);
          target ??= countOnBranch(tree, bird.targetBranch) < speciesOf(tree).maxCohortPerBranch
            ? bird.targetBranch
            : leastLoadedWithRoom(tree, tree.branches.map((b) => b.id), bird.lastBranch);
          if (target === null) { bird.plannedFlight = drawFlight(); continue; } // 无空位再盘旋一段
          if (!monophonyAllows(tree)) { // 单音性弹开：继续飞一段再来
            bird.plannedFlight = drawFlight();
            continue;
          }
          landOn(bird, target, 'settle');
          bird.mode = 'day';
          bird.plannedDwell = drawDwell(tree);
        }
        continue;
      }
      // mode === 'day'
      if (bird.state === 'flying') {
        if (bird.flightTime >= bird.plannedFlight) {
          let target = preferredReturnBranch(bird);
          target ??= leastLoadedWithRoom(
            tree, branchIdsFor(tree).filter((id) => id !== bird.lastBranch), bird.lastBranch,
          ) ?? leastLoadedWithRoom(tree, branchIdsFor(tree), bird.lastBranch);
          if (target === null) { bird.plannedFlight = drawFlight(); continue; }
          if (!monophonyAllows(tree)) { bird.plannedFlight = drawFlight(); continue; }
          landOn(bird, target, 'hop');
          bird.plannedDwell = drawDwell(tree);
        }
        continue;
      }
      if (bird.dwellTime < bird.plannedDwell) continue; // 驻留预算未尽：不动
      // 驻留预算耗尽，是否换枝由本能决定：
      if (!inActivityWindow(tree)) { bird.plannedDwell += cfg.dayCycle.holdRecheckBeats * secondsPerBeat(); continue; } // 窗口外静栖
      // C2：runner 迈步 —— 在 switchQuota 冻结之前；触发=鸟到达邻节点，非时钟扫描。
      const onRunner = branchById(tree, bird.branchId)?.isRunner;
      if (onRunner) {
        const walkSnap = takeoffSnapDelaySeconds(
          state.simTime, state.bpm, cfg.dayCycle.takeoffSnapWindowBeats,
        );
        if (walkSnap > 0) {
          bird.plannedDwell = bird.dwellTime + walkSnap;
          continue;
        }
        const walkProb = clamp(Number(speciesOf(tree).walkProbability) || 0, 0, 1);
        const walkTarget = walkProb > 0 ? pickWalkBranch(bird) : null;
        if (walkTarget !== null && rng() < walkProb) {
          // 瞬时迈步：同 tick 离旧节点、落邻节点；各发一次 unperch/perch（cause:'walk'）。
          launch(bird, 'walk');
          landOn(bird, walkTarget, 'walk');
          bird.mode = 'day';
          bird.plannedDwell = drawDwell(tree);
          continue;
        }
        // 未迈步：续栖 = 持续单音（单鸟静止不跑音序）
        bird.plannedDwell += cfg.dayCycle.holdRecheckBeats * secondsPerBeat();
        continue;
      }
      if (bird.switchesUsed >= speciesOf(tree).switchQuota) { bird.plannedDwell = Infinity; continue; } // 配额尽：驻到下个黎明
      if (bird.energy < cfg.birds.energyHopFloor) { bird.plannedDwell += cfg.dayCycle.holdRecheckBeats * secondsPerBeat(); continue; } // 体力不支
      // 唯一脉感本能：若此刻已进入下一拍前的小窗口，等到拍点再决定起飞。
      // 只延后 takeoff；随机飞行预算与 land onset 完全不吸附。
      const snapDelay = takeoffSnapDelaySeconds(
        state.simTime, state.bpm, cfg.dayCycle.takeoffSnapWindowBeats,
      );
      if (snapDelay > 0) {
        bird.plannedDwell = bird.dwellTime + snapDelay;
        continue;
      }
      // 发声偏置（0..1）：<1 时按概率推迟 hop，给跨声部错峰留白；缺省 1 ≡ 旧行为。
      const bias = vocalizeBias[tree.id] ?? 1;
      if (bias < 1 && rng() > bias) {
        bird.plannedDwell += cfg.dayCycle.holdRecheckBeats * secondsPerBeat();
        continue;
      }
      const hopTarget = pickHopBranch(bird); // 偏向今日到访最少的枝
      if (hopTarget === null) { bird.plannedDwell += cfg.dayCycle.holdRecheckBeats * secondsPerBeat(); continue; } // 他枝皆满
      bird.targetBranch = hopTarget;
      launch(bird, 'hop');
      bird.plannedFlight = drawFlight();
    }
  }

  function physiologyStep(dt) {
    for (const bird of birds) {
      const tree = treeOf(bird);
      if (bird.state === 'flying') {
        bird.flightTime += dt;
        bird.energy = clamp(bird.energy - cfg.birds.energyDrainPerSecond * dt);
        bird.orbitAngle += bird.orbitSpeed * dt;
        bird.bobPhase += cfg.birds.orbitBobSpeed * dt;
        bird.pos = {
          x: tree.xOffset + Math.cos(bird.orbitAngle) * bird.orbitRadius,
          y: cfg.tree.trunkHeight * 0.9 + Math.sin(bird.orbitAngle) * bird.orbitRadius * 0.45
            + Math.sin(bird.bobPhase) * cfg.birds.orbitBobAmplitude,
        };
      } else {
        bird.dwellTime += dt;
        bird.dwellBeatTime += dt / secondsPerBeat();
        bird.energy = clamp(bird.energy + cfg.birds.energyRecoverPerSecond * dt);
      }
    }
  }

  // ---- 昼夜推进：跨过黎明/黄昏线时显式发事件（各恰好一次）----
  function phaseStep(dt) {
    const prev = state.phase;
    let next = prev + dt / state.dayLength;
    if (next >= 1) {
      next -= 1;
      state.phase = next;
      state.daylight = daylightFromPhase(next);
      onDawn();
      return;
    }
    state.phase = next;
    state.daylight = daylightFromPhase(next);
    if (prev < cfg.sim.duskPhase && next >= cfg.sim.duskPhase) onDusk();
  }

  function tick(dt) {
    state.simTime += dt;
    phaseStep(dt);
    behaviorStep();
    physiologyStep(dt);
    for (const tree of trees) {
      tree.stats.dayTime += dt;
      if (perchedOnTree(tree) < cfg.agent.silentPerchedBelow) tree.stats.silentTime += dt;
    }
  }

  // ---- 日界计划写入 API（conductor 在黎明钩子里调用）----
  function setHomeBranch(birdId, branchId) {
    const bird = birds[birdId];
    if (!bird) return false;
    const tree = treeOf(bird);
    if (!branchById(tree, branchId) || !branchAllowed(tree, branchId)) return false;
    bird.homeBranch = branchId;
    return true;
  }
  // 换季生效日调用一次：只处理声明 seasonMigrationOnly 的物种，并保证同一天幂等。
  function applySeasonChange(day = state.day) {
    const moves = [];
    for (const tree of trees) {
      if (!speciesOf(tree).seasonMigrationOnly || tree.lastSeasonMigrationDay === day) continue;
      tree.lastSeasonMigrationDay = day;
      const allowed = branchIdsFor(tree);
      if (allowed.length < 2) continue;
      for (const bird of tree.birds) {
        const from = bird.homeBranch;
        const index = Math.max(0, allowed.indexOf(from));
        const to = allowed[(index + 1) % allowed.length];
        if (to !== from && setHomeBranch(bird.id, to)) moves.push({ treeId: tree.id, birdId: bird.id, from, to });
      }
    }
    if (moves.length) emit('season-migration', { day, moves: moves.map((move) => ({ ...move })) });
    return moves;
  }
  function setDensityTier(treeId, tier) {
    const tree = trees.find((t) => t.id === treeId);
    if (!tree || !(tier in cfg.agent.densityTiers)) return false;
    tree.densityTier = tier;
    return true;
  }
  // 日界计划（音乐单位）：dwellBeats 驻留预算（拍）、activeBars 每日活跃小节数
  function setFlockPlan(treeId, { dwellBeats, activeBars } = {}) {
    const tree = trees.find((t) => t.id === treeId);
    if (!tree) return false;
    if (Number.isFinite(dwellBeats) && dwellBeats > 0) tree.dwellBeats = dwellBeats;
    if (Number.isFinite(activeBars) && activeBars >= 0) {
      tree.activeBars = clamp(activeBars, 0, cfg.tempo.barsPerDay);
    }
    return true;
  }
  function setTempo(bpm) {
    const next = clamp(Number(bpm), cfg.tempo.bpmMin, cfg.tempo.bpmMax);
    if (!Number.isFinite(next)) return false;
    const remainingScale = state.bpm / next;
    // 已消耗的墙钟时间不回写；只把剩余驻留/飞行预算按新每拍秒数缩放，
    // 因而变速不会改变尚未完成的音乐行为拍数。
    for (const bird of birds) {
      if (Number.isFinite(bird.plannedDwell)) {
        bird.plannedDwell = bird.dwellTime
          + Math.max(0, bird.plannedDwell - bird.dwellTime) * remainingScale;
      }
      if (Number.isFinite(bird.plannedFlight)) {
        bird.plannedFlight = bird.flightTime
          + Math.max(0, bird.plannedFlight - bird.flightTime) * remainingScale;
      }
    }
    state.bpm = next;
    state.dayLength = cfg.tempo.barsPerDay * cfg.tempo.beatsPerBar * 60 / next;
    return true;
  }

  // ---- 快照：renderer / agent / 日志的唯一数据入口 ----
  function getSnapshot() {
    return {
      simTime: state.simTime,
      day: state.day,
      phase: state.phase,
      bpm: state.bpm,
      dayLength: state.dayLength,
      daylight: state.daylight,
      trees: trees.map((tree) => ({
        id: tree.id,
        species: tree.speciesName,
        xOffset: tree.xOffset,
        mirror: tree.mirror,
        drawScale: tree.drawScale,
        registerOffset: tree.registerOffset,
        densityTier: tree.densityTier,
        dwellBeats: tree.dwellBeats,
        activeBars: tree.activeBars,
        trunkBase: { x: tree.xOffset, y: 0 },
        trunkTop: { x: tree.xOffset, y: cfg.tree.trunkHeight },
        branches: tree.branches.map((b) => ({
          id: b.id,
          isRunner: !!b.isRunner,
          runnerId: b.runnerId,
          nodeIndex: b.nodeIndex,
          nodeCount: b.nodeCount,
          base: { x: tree.xOffset + b.base.x, y: b.base.y },
          tip: { x: tree.xOffset + b.tip.x, y: b.tip.y },
          slots: b.slots.map((s) => ({ x: tree.xOffset + s.x, y: s.y })),
        })),
        birds: tree.birds.map((b) => ({
          id: b.id,
          treeId: b.treeId,
          state: b.state,
          branchId: b.branchId,
          homeBranch: b.homeBranch,
          activeToday: b.activeToday,
          mode: b.mode,
          switchesUsed: b.switchesUsed,
          energy: b.energy,
          dwellTime: b.dwellTime,
          dwellBeatTime: b.dwellBeatTime,
          flightTime: b.flightTime,
          plannedDwell: b.plannedDwell,
          plannedFlight: b.plannedFlight,
          returnBranch: b.returnBranch,
          slotIndex: b.slotIndex,
          pos: { ...b.pos },
        })),
        perchedTotal: perchedOnTree(tree),
        meanEnergy: tree.birds.reduce((s, b) => s + b.energy, 0) / tree.birds.length,
      })),
      birds: birds.map((b) => ({
        id: b.id,
        treeId: b.treeId,
        state: b.state,
        branchId: b.branchId,
        homeBranch: b.homeBranch,
        activeToday: b.activeToday,
        mode: b.mode,
        switchesUsed: b.switchesUsed,
        energy: b.energy,
        dwellTime: b.dwellTime,
        dwellBeatTime: b.dwellBeatTime,
        flightTime: b.flightTime,
        plannedDwell: b.plannedDwell,
        plannedFlight: b.plannedFlight,
        returnBranch: b.returnBranch,
        slotIndex: b.slotIndex,
        pos: { ...b.pos },
      })),
      perchedTotal: perchedTotal(),
      meanEnergy: birds.reduce((s, b) => s + b.energy, 0) / birds.length,
    };
  }

  // 初始化：开局即一次「黎明归巢」（起始相位在清晨，鸟群落定成初始 pattern）
  onDawn();
  state.day = 1; // onDawn 自增回退：开局仍算第 1 天

  return {
    on, onBeforeDawn, tick,
    perchBird, unperchBird,
    userPlaceOnBranch, userShooBird,
    setTreeControl, getTreeControl,
    setHomeBranch, applySeasonChange, setDensityTier, setFlockPlan, setTempo,
    setBranchPreference, getBranchPreference,
    setVocalizeBias, getVocalizeBias,
    getSnapshot,
  };
}
