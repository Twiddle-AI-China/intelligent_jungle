// mvp/test/world.test.js —— 事件发射正确性：落枝恰好一个 perch，跨线恰好一个 dawn/dusk，
// 以及 Phase 1.5 的内核本能（黎明归巢、夜里归栖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beatsToSeconds,
  createWorld,
  daylightFromPhase,
  densitySizeForTier,
  pickIndexByWeights,
  snapDwellDurationSeconds,
  takeoffSnapDelaySeconds,
} from '../src/world.js';
import { CONFIG } from '../src/config.js';
import { mulberry32, advanceTo } from './helpers.js';

function recorder(world, ...types) {
  const events = [];
  for (const t of types) world.on(t, (e) => events.push({ type: t, ...e }));
  return events;
}

test('perchBird：落枝恰好发出一个 perch 事件，重复调用不重复发', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const events = recorder(world, 'perch');

  assert.equal(world.perchBird(0, 2), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].birdId, 0);
  assert.equal(events[0].branchId, 2);
  assert.equal(events[0].perchedOnBranch, 1);

  // 已栖状态下再次 perchBird：守卫拒绝，无新事件
  assert.equal(world.perchBird(0, 2), false);
  assert.equal(world.perchBird(0, 3), false);
  assert.equal(events.length, 1);
});

test('unperchBird：离枝恰好一个 unperch 事件，带驻留时长；未栖不发', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const events = recorder(world, 'perch', 'unperch');

  world.perchBird(1, 0);
  world.tick(0.5); // 驻留累计（settleAt=3s 未到，不会被内核挪走）
  assert.equal(world.unperchBird(1), true);
  const unperch = events.filter((e) => e.type === 'unperch');
  assert.equal(unperch.length, 1);
  assert.equal(unperch[0].birdId, 1);
  assert.equal(unperch[0].branchId, 0);
  assert.ok(unperch[0].dwellTime > 0, 'unperch 必须带 dwellTime');

  assert.equal(world.unperchBird(1), false);
  assert.equal(events.filter((e) => e.type === 'unperch').length, 1);
});

test('昼夜事件：跨黄昏恰好一个 dusk（纯节点），相位归零恰好一个 dawn（带日终统计）', () => {
  const config = structuredClone(CONFIG);
  config.sim.startPhase = 0.49;
  config.tempo.defaultBpm = 96; // dayLength = 4×4×60/96 = 10s
  const world = createWorld({ config, rng: () => 0.999 });
  const events = recorder(world, 'dawn', 'dusk');

  for (let i = 0; i < 20; i += 1) world.tick(1 / 30); // ≈0.67s → phase ≈ 0.557
  assert.equal(events.filter((e) => e.type === 'dusk').length, 1);
  assert.equal(events.filter((e) => e.type === 'dawn').length, 0);

  for (let i = 0; i < 150; i += 1) world.tick(1 / 30); // 5s → phase 跨过 1.0
  const dawns = events.filter((e) => e.type === 'dawn');
  assert.equal(dawns.length, 1);
  assert.equal(dawns[0].day, 2);
  assert.ok(dawns[0].stats && dawns[0].stats.day === 1, 'dawn 必须携带刚结束那天的日终统计');
  assert.ok(dawns[0].stats.trees?.pad && dawns[0].stats.trees?.melody, '日终统计按树分组');
  assert.ok(Array.isArray(dawns[0].stats.trees.pad.branchLoads));
  assert.equal(events.filter((e) => e.type === 'dusk').length, 1);
});

test('daylightFromPhase：正午最亮、午夜最暗、黎明黄昏居中', () => {
  assert.equal(daylightFromPhase(0.25), 1);
  assert.equal(daylightFromPhase(0.75), 0);
  assert.ok(Math.abs(daylightFromPhase(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(daylightFromPhase(0.5) - 0.5) < 1e-9);
});

test('黎明归巢：两树活跃鸟各自在归巢窗口内落枝，形成当日 pattern', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(42) });
  const settleCounts = Object.fromEntries(CONFIG.trees.map((t) => [t.id, 0]));
  world.on('perch', (e) => {
    if (e.cause === 'settle' && e.treeId in settleCounts) settleCounts[e.treeId] += 1;
  });
  // 多鹈鹕拉长共享 rng；以 settle 事件计数为准（短驻/单音弹开物种采样瞬间可能在飞）
  const s = advanceTo(world, 1, 0.55);
  for (const tree of s.trees) {
    const sp = CONFIG.species[tree.species];
    const allowedCount = (sp.allowedBranches ?? tree.branches.map((b) => b.id)).length;
    const capacity = sp.maxCohortPerBranch * allowedCount - (sp.switchQuota > 0 ? 1 : 0);
    const expectSize = densitySizeForTier(
      tree.densityTier, tree.birds.length, capacity, CONFIG.agent.densityTiers,
    );
    const perchedActive = tree.birds.filter((b) => b.activeToday && b.state === 'perched').length;
    const settled = settleCounts[tree.id];
    assert.ok(settled >= Math.max(1, expectSize - 1) || perchedActive >= Math.max(1, expectSize - 1),
      `${tree.id} 归巢后应有 settle 落枝，settle=${settled} 实栖=${perchedActive}，期望 ≥ ${expectSize - 1}`);
  }
});

test('密度档位按每树容量比例化，小群树的 sparse/normal/full 不空转', () => {
  assert.deepEqual(['sparse', 'normal', 'full'].map((tier) => densitySizeForTier(
    tier, 3, 3, CONFIG.agent.densityTiers,
  )), [1, 2, 3], 'melody/texture 三鸟群三档各自可达');
  assert.deepEqual(['sparse', 'normal', 'full'].map((tier) => densitySizeForTier(
    tier, 2, 2, CONFIG.agent.densityTiers,
  )), [1, 1, 2], 'bass 两鸟群 sparse 仍至少一只，不再灭族');
  assert.deepEqual(['sparse', 'normal', 'full'].map((tier) => densitySizeForTier(
    tier, 5, 5, CONFIG.agent.densityTiers,
  )), [2, 3, 5]);
});

test('起飞吸拍：驻留到期只在 ±窗内贴最近拍，飞行/落枝预算不参与', () => {
  const bpm = 60;
  assert.ok(Math.abs(snapDwellDurationSeconds(0.1, 0.8, bpm, 0.25) - 0.9) < 1e-9,
    '到期 0.9 拍向后延到第 1 拍');
  assert.ok(Math.abs(snapDwellDurationSeconds(0.1, 1.05, bpm, 0.25) - 0.9) < 1e-9,
    '到期 1.15 拍向前收至第 1 拍');
  assert.equal(snapDwellDurationSeconds(0.1, 1.4, bpm, 0.25), 1.4,
    '离拍点超过窗口保持自然驻留');
  assert.ok(Math.abs(takeoffSnapDelaySeconds(0.8, bpm, 0.25) - 0.2) < 1e-9,
    '运行期计划被变速扰动后，下一拍前窗口仍可因果地等待');
  assert.equal(takeoffSnapDelaySeconds(0.2, bpm, 0.25), 0,
    '已经过去的拍点不回拨，也不把起飞硬推到再下一拍');
});

test('夜晚不静默：1.6R 无归栖本能，pad 全天驻留、无 roost 模式', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(7) });
  const s = advanceTo(world, 1, 0.75); // 午夜
  assert.ok(s.perchedTotal >= 4, `pad 夜里照常驻留演奏，实栖 ${s.perchedTotal}`);
  assert.ok(s.birds.every((b) => b.mode !== 'roost'), '1.6R 已删除 roost 模式');
});

test('快照：四树世界形状——四树各带物种/鸟群/几何，鸟有 treeId', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  world.perchBird(0, 1);
  const s = world.getSnapshot();
  assert.equal(s.trees.length, 4, '四树');
  const [pad, melody, bass, texture] = s.trees;
  assert.equal(pad.species, 'pad');
  assert.equal(melody.species, 'melody');
  assert.equal(bass.species, 'bass');
  assert.equal(texture.species, 'texture');
  assert.equal(pad.birds.length, CONFIG.trees[0].birdCount);
  assert.equal(melody.birds.length, CONFIG.trees[1].birdCount);
  assert.equal(pad.branches.length, 5);
  assert.ok(bass.branches.filter((b) => b.isRunner).length === 5, 'bass 树挂 5 个 runner 节点');
  assert.equal(bass.birds.length, CONFIG.trees.find((t) => t.id === 'bass').birdCount);
  assert.deepEqual(s.trees.map((tree) => tree.xOffset), [-0.33, -0.11, 0.11, 0.33]);
  assert.ok(s.birds.every((b) => typeof b.treeId === 'string'));
  assert.equal(s.perchedTotal, 1);
  assert.equal(s.birds[0].state, 'perched');
  assert.ok(Number.isInteger(s.birds[0].homeBranch), '快照须含家枝');
  assert.ok(Math.abs(pad.branches[1].slots[0].x - (pad.xOffset + melody.branches[1].slots[0].x - melody.xOffset)) < 1e-9);
  assert.ok(Number.isFinite(s.dayLength) && Number.isFinite(s.bpm));
  assert.ok(Number.isFinite(s.daylight) && Number.isFinite(s.meanEnergy));
});

test('landOn 槽位从 0 起，activeBars=0 是合法静默计划', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  assert.equal(world.perchBird(0, 1), true);
  const bird = world.getSnapshot().birds[0];
  assert.equal(bird.slotIndex, 0);
  assert.equal(world.setFlockPlan('pad', { activeBars: 0 }), true);
  assert.equal(world.getSnapshot().trees.find((tree) => tree.id === 'pad').activeBars, 0);
});

test('bass 栖 runner 节点，换季批量迁移且同一生效日幂等', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0 });
  const before = world.getSnapshot().trees.find((tree) => tree.id === 'bass');
  const allowed = CONFIG.species.bass.allowedBranches;
  assert.ok(before.birds.every((bird) => bird.homeBranch === allowed[0]),
    '开局家枝应落在 runner 西端（allowed 最小 id）');
  assert.equal(world.setHomeBranch(before.birds[0].id, 4), false, 'bass 不接受纵向高枝');
  assert.ok(before.branches.filter((b) => b.isRunner).length >= 5, 'bass 树应挂横向 runner 节点');
  const moves = world.applySeasonChange(2);
  assert.equal(moves.length, CONFIG.trees.find((tree) => tree.id === 'bass').birdCount);
  assert.ok(world.getSnapshot().trees.find((tree) => tree.id === 'bass').birds
    .every((bird) => bird.homeBranch === allowed[1]));
  assert.deepEqual(world.applySeasonChange(2), [], '同一换季生效日不得重复迁移');
});

test('C2：鹈鹕在 runner 上驻留到期可迈步到邻节点（cause=walk），不耗 switchQuota', () => {
  const config = structuredClone(CONFIG);
  config.trees = config.trees.filter((t) => t.id === 'bass');
  config.trees[0].birdCount = 1;
  config.species.bass.dwellBeats = 0.5;
  config.species.bass.dwellJitter = 0;
  config.species.bass.walkProbability = 1;
  config.agent.densityTiers = { sparse: 1, normal: 1, full: 1 };
  const world = createWorld({ config, rng: () => 0.01 });
  const walks = [];
  world.on('perch', (e) => { if (e.cause === 'walk') walks.push(e); });
  for (let i = 0; i < 800 && walks.length < 2; i += 1) world.tick(1 / 30);
  assert.ok(walks.length >= 1, '应至少迈步一次');
  assert.ok(walks.every((e) => e.isRunner && Number.isInteger(e.nodeIndex)),
    '迈步 perch 须带 runner 形态标记');
  const bird = world.getSnapshot().birds[0];
  assert.equal(bird.switchesUsed, 0, '迈步不计入换枝配额');
  assert.equal(bird.state, 'perched');
});

test('C2：walkProbability=0 时单鸟静止不产生 walk（持续单音，非跑动琶音）', () => {
  const config = structuredClone(CONFIG);
  config.trees = config.trees.filter((t) => t.id === 'bass');
  config.trees[0].birdCount = 1;
  config.species.bass.dwellBeats = 0.4;
  config.species.bass.dwellJitter = 0;
  config.species.bass.walkProbability = 0;
  config.agent.densityTiers = { sparse: 1, normal: 1, full: 1 };
  const world = createWorld({ config, rng: () => 0.5 });
  const walks = [];
  const perches = [];
  world.on('perch', (e) => {
    perches.push(e);
    if (e.cause === 'walk') walks.push(e);
  });
  for (let i = 0; i < 600; i += 1) world.tick(1 / 30);
  assert.equal(walks.length, 0, '静止鹈鹕不得自行跑节点');
  const settle = perches.filter((e) => e.cause === 'settle');
  assert.ok(settle.length >= 1);
  const bird = world.getSnapshot().birds[0];
  assert.equal(bird.state, 'perched');
  assert.equal(bird.branchId, settle[settle.length - 1].branchId);
});

test('texture 离枝后按配置偏置返回同一枝', () => {
  const config = structuredClone(CONFIG);
  config.trees = [{ id: 'texture', species: 'texture', xOffset: 0, birdCount: 1, registerOffset: 0 }];
  config.species.texture.returnBranchProbability = 1;
  config.species.texture.dwellBeats = 0.05;
  config.species.texture.dwellJitter = 0;
  config.birds.flightBaseSeconds = 0.01;
  config.birds.flightJitter = 0;
  config.agent.densityTiers = { sparse: 1, normal: 1, full: 1 };
  const world = createWorld({ config, rng: () => 0 });
  const hops = [];
  world.on('perch', (event) => { if (event.cause === 'hop') hops.push(event); });
  for (let i = 0; i < 300 && !hops.length; i += 1) world.tick(1 / 30);
  assert.ok(hops.length > 0, 'texture 应完成至少一次起落');
  assert.equal(hops[0].branchId, 0, '离枝后返回刚离开的枝');
});

test('texture 回枝偏置覆盖黎明 settle 自主起飞后的下一次落枝', () => {
  const config = structuredClone(CONFIG);
  config.trees = [{ id: 'texture', species: 'texture', xOffset: 0, birdCount: 1, registerOffset: 0 }];
  config.species.texture.returnBranchProbability = 1;
  config.species.texture.fidelity = 1;
  config.species.texture.dwellJitter = 0;
  config.birds.flightBaseSeconds = 0.05;
  config.birds.flightJitter = 0;
  const world = createWorld({ config, rng: () => 0 });
  const settled = advanceTo(world, 1, 0.25).birds[0];
  assert.equal(settled.state, 'perched');
  const departedBranch = settled.branchId;
  const otherHome = (departedBranch + 1) % config.tree.branches.length;
  world.setHomeBranch(settled.id, otherHome); // 下一黎明 target 改变，触发 settle 自主离枝
  const events = [];
  world.on('unperch', (event) => { if (event.cause === 'settle') events.push({ type: 'up', ...event }); });
  world.on('perch', (event) => { if (event.cause === 'settle') events.push({ type: 'down', ...event }); });

  advanceTo(world, 2, 0.25);
  const departure = events.find((event) => event.type === 'up');
  const landing = events.find((event) => event.type === 'down');
  assert.ok(departure && landing, '应发生一次黎明 settle 起落');
  assert.equal(landing.branchId, departure.branchId, 'settle 路径也必须消费回同枝偏置');
  assert.equal(landing.returnedToLastBranch, true);
});

test('setTempo：BPM 派生昼夜时长，即时生效、相位连续、速率改变', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const s0 = world.getSnapshot();
  // 默认 60 BPM：4×4×60/60 = 16s/昼夜
  assert.equal(s0.bpm, CONFIG.tempo.defaultBpm);
  assert.ok(Math.abs(s0.dayLength - 16) < 1e-9);
  advanceTo(world, 1, 0.3);
  const before = world.getSnapshot().phase;
  assert.equal(world.setTempo(120), true); // 120 BPM → 8s/昼夜，速率翻倍
  for (let i = 0; i < 4 * CONFIG.sim.tickHz; i += 1) world.tick(1 / 30); // 4s
  const after = world.getSnapshot().phase;
  assert.ok(after > before + 0.45, `120BPM 下 4s 应走 ≈0.5 相位，实走 ${(after - before).toFixed(2)}`);
  assert.equal(world.setTempo(NaN), false);
  // 夹取边界
  world.setTempo(999);
  assert.equal(world.getSnapshot().bpm, CONFIG.tempo.bpmMax);
});

test('拍→秒换算：beatsToSeconds 与驻留尺度随 BPM 线性缩放', () => {
  assert.equal(beatsToSeconds(40, 60), 40);
  assert.equal(beatsToSeconds(40, 120), 20);
  // 变速只改秒不改拍：pad 驻留预算（拍）不随 tempo 变
  const world = createWorld({ config: CONFIG, rng: mulberry32(3) });
  const before = world.getSnapshot().trees.find((t) => t.id === 'pad').dwellBeats;
  world.setTempo(120);
  const after = world.getSnapshot().trees.find((t) => t.id === 'pad').dwellBeats;
  assert.equal(before, after);
});

test('setTempo 按拍数缩放在途驻留与飞行剩余预算', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(12) });
  const settled = advanceTo(world, 1, 0.25).trees.find((tree) => tree.id === 'pad').birds
    .find((bird) => bird.state === 'perched' && Number.isFinite(bird.plannedDwell));
  assert.ok(settled);
  const remainingBefore = settled.plannedDwell - settled.dwellTime;
  world.setTempo(120);
  const after = world.getSnapshot().birds.find((bird) => bird.id === settled.id);
  const remainingAfter = after.plannedDwell - after.dwellTime;
  assert.ok(Math.abs(remainingAfter - remainingBefore / 2) < 1e-9);

  const flightConfig = structuredClone(CONFIG);
  flightConfig.trees = [{ id: 'texture', species: 'texture', xOffset: 0, birdCount: 1, registerOffset: 0 }];
  flightConfig.species.texture.dwellBeats = 0.05;
  flightConfig.species.texture.dwellJitter = 0;
  flightConfig.birds.flightBaseSeconds = 0.9;
  flightConfig.birds.flightJitter = 0;
  const flightWorld = createWorld({ config: flightConfig, rng: () => 0 });
  let launched = false;
  flightWorld.on('unperch', (event) => { if (event.cause === 'hop') launched = true; });
  for (let i = 0; i < 300 && !launched; i += 1) flightWorld.tick(1 / 30);
  const flyingBefore = flightWorld.getSnapshot().birds.find((bird) => bird.state === 'flying');
  assert.ok(flyingBefore && flyingBefore.plannedFlight > flyingBefore.flightTime);
  const flightRemainingBefore = flyingBefore.plannedFlight - flyingBefore.flightTime;
  flightWorld.setTempo(120);
  const flyingAfter = flightWorld.getSnapshot().birds.find((bird) => bird.id === flyingBefore.id);
  const flightRemainingAfter = flyingAfter.plannedFlight - flyingAfter.flightTime;
  assert.ok(Math.abs(flightRemainingAfter - flightRemainingBefore / 2) < 1e-9);
});

test('melody 单音性：弹开概率主导——rng 小于 0.9 被弹开，大于等于允许装饰双音', () => {
  // 全程弹开（0.5 < 0.9）：melody 树最多 1 只栖着
  const w1 = createWorld({ config: CONFIG, rng: () => 0.5 });
  const s1 = advanceTo(w1, 1, 0.5);
  const m1 = s1.trees.find((t) => t.id === 'melody');
  assert.ok(m1.perchedTotal <= 1, `rng 恒 0.5 时 melody 树应 ≤1 只栖着，实 ${m1.perchedTotal}`);

  // 全程允许（0.95 ≥ 0.9）：装饰双音放开，melody 树能栖 2 只以上
  const w2 = createWorld({ config: CONFIG, rng: () => 0.95 });
  const s2 = advanceTo(w2, 1, 0.75);
  const m2 = s2.trees.find((t) => t.id === 'melody');
  assert.ok(m2.perchedTotal >= 2, `rng 恒 0.95 时 melody 树应 ≥2 只栖着，实 ${m2.perchedTotal}`);
});

// ---- 枝偏好权重（T-张力偏置 P0-B）：world 只吃 0..1 纯数字 ----

function hopTrace(seed, setWeights) {
  const config = structuredClone(CONFIG);
  // texture：高频 hop、无单音弹开，便于采样选枝分布
  config.species.texture.dwellBeats = 0.4;
  config.species.texture.dwellJitter = 0;
  config.species.texture.switchQuota = 40;
  config.species.texture.returnBranchProbability = 0; // 关回枝，专测 pickHopBranch
  config.trees = config.trees.filter((t) => t.id === 'texture');
  config.trees[0].birdCount = 3;
  const world = createWorld({ config, rng: mulberry32(seed) });
  if (setWeights) setWeights(world);
  const hops = [];
  world.on('perch', (e) => {
    if (e.cause === 'hop' && e.treeId === 'texture') hops.push(e.branchId);
  });
  for (let i = 0; i < 2500 && hops.length < 120; i += 1) world.tick(1 / 30);
  return hops;
}

test('枝偏好全 1：与缺省行为逐 tick 事件序列一致（防回归）', () => {
  const a = hopTrace(91, null);
  const b = hopTrace(91, (w) => {
    assert.equal(w.setBranchPreference('texture', [1, 1, 1, 1, 1]), true);
  });
  assert.ok(a.length >= 40, `应采到足够 hop，实 ${a.length}`);
  assert.deepEqual(a, b, '显式全 1 权重不得改变 rng 序列/选枝');
});

test('枝偏好偏置：低权枝显著少选（分布单调）', () => {
  const favorLow = hopTrace(42, (w) => {
    // 低序号枝权重高、高序号枝近 0
    w.setBranchPreference('texture', [1, 1, 1, 0.05, 0.05]);
  });
  const favorHigh = hopTrace(42, (w) => {
    // 高序号枝权重高、低序号枝近 0
    w.setBranchPreference('texture', [0.05, 0.05, 0.05, 1, 1]);
  });
  assert.ok(favorLow.length >= 40 && favorHigh.length >= 40);

  const share = (hops, pred) => hops.filter(pred).length / hops.length;
  const highShareFavorLow = share(favorLow, (id) => id >= 3);
  const highShareFavorHigh = share(favorHigh, (id) => id >= 3);
  const lowShareFavorLow = share(favorLow, (id) => id < 3);
  const lowShareFavorHigh = share(favorHigh, (id) => id < 3);

  assert.ok(
    highShareFavorHigh > highShareFavorLow + 0.25,
    `高序号枝占比应随其权重上升：favorLow=${highShareFavorLow.toFixed(2)} favorHigh=${highShareFavorHigh.toFixed(2)}`,
  );
  assert.ok(
    lowShareFavorLow > lowShareFavorHigh + 0.25,
    `低序号枝占比应随其权重上升：favorLow=${lowShareFavorLow.toFixed(2)} favorHigh=${lowShareFavorHigh.toFixed(2)}`,
  );
});

test('枝偏好不影响 manual/user 落枝与 texture 回枝', () => {
  // —— manual / user：指定枝必达，无视权重 ——
  const manualWorld = createWorld({ config: CONFIG, rng: () => 0.5 });
  manualWorld.setBranchPreference('texture', [0, 0, 0, 1, 1]);
  assert.equal(manualWorld.perchBird(0, 0), true);
  assert.equal(manualWorld.getSnapshot().birds[0].branchId, 0);
  manualWorld.unperchBird(0);
  // texture 鸟 id 随四树布局变化；用 snapshot 找 texture 树的一只 flying
  const texBird = manualWorld.getSnapshot().trees.find((t) => t.id === 'texture').birds
    .find((b) => b.state === 'flying')
    ?? manualWorld.getSnapshot().trees.find((t) => t.id === 'texture').birds[0];
  if (texBird.state === 'perched') manualWorld.unperchBird(texBird.id);
  const placed = manualWorld.userPlaceOnBranch('texture', 1);
  assert.ok(placed && placed.branchId === 1, 'userPlace 应落到指定枝');
  assert.equal(
    manualWorld.getSnapshot().birds.find((b) => b.id === placed.birdId).branchId,
    1,
  );

  // —— 回枝：沿用既有 texture 单树短驻留装置，权重全压向非出发枝 ——
  const config = structuredClone(CONFIG);
  config.trees = [{ id: 'texture', species: 'texture', xOffset: 0, birdCount: 1, registerOffset: 0 }];
  config.species.texture.returnBranchProbability = 1;
  config.species.texture.dwellBeats = 0.05;
  config.species.texture.dwellJitter = 0;
  config.birds.flightBaseSeconds = 0.01;
  config.birds.flightJitter = 0;
  config.agent.densityTiers = { sparse: 1, normal: 1, full: 1 };
  const world = createWorld({ config, rng: () => 0 });
  // 出发枝由 rng=0 黎明决定；把其余枝权拉满、出发枝压 0，若权重污染回枝则会偏走
  world.setBranchPreference('texture', [0, 1, 1, 1, 1]);
  const hops = [];
  world.on('perch', (event) => { if (event.cause === 'hop') hops.push(event); });
  for (let i = 0; i < 300 && !hops.length; i += 1) world.tick(1 / 30);
  assert.ok(hops.length > 0, 'texture 应完成至少一次起落');
  assert.equal(hops[0].branchId, 0, 'preferredReturnBranch 不受权重影响，仍回出发枝');
});

test('setBranchPreference：未知树拒绝；缺省 get 为全 1；权重夹到 0..1', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  assert.equal(world.setBranchPreference('nope', [1, 1, 1, 1, 1]), false);
  assert.deepEqual(world.getBranchPreference('pad'), [1, 1, 1, 1, 1]);
  assert.equal(world.setBranchPreference('pad', [2, -1, 0.5, Number.NaN]), true);
  assert.deepEqual(world.getBranchPreference('pad'), [1, 0, 0.5, 1, 1]);
});

test('setVocalizeBias：缺省 1；夹到 0..1；未知树拒绝', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  assert.equal(world.getVocalizeBias('pad'), 1);
  assert.equal(world.setVocalizeBias('nope', 0.5), false);
  assert.equal(world.setVocalizeBias('pad', 2), true);
  assert.equal(world.getVocalizeBias('pad'), 1);
  assert.equal(world.setVocalizeBias('melody', -0.5), true);
  assert.equal(world.getVocalizeBias('melody'), 0);
  assert.equal(world.setVocalizeBias('bass', 0.25), true);
  assert.equal(world.getVocalizeBias('bass'), 0.25);
});

test('config.harmony.tensionBranchBias 提供 conductor 换算参数', () => {
  const bias = CONFIG.harmony.tensionBranchBias;
  assert.ok(bias && Number.isFinite(bias.skeletonWeight));
  assert.ok(bias.colorWeightAt0 < bias.colorWeightAt1);
  assert.ok(bias.colorWeightAt0 >= 0 && bias.colorWeightAt1 <= 1);
});

test('pickIndexByWeights：rng()*n 恰为整数时与 Math.floor 精确等价（P1）', () => {
  const n = 4;
  const weights = [1, 1, 1, 1];
  for (const u of [0, 0.25, 0.5, 0.75]) {
    const got = pickIndexByWeights(weights, () => u);
    const expected = Math.floor(u * n);
    assert.equal(got, expected, `u=${u}: weighted=${got} floor=${expected}`);
  }
  // 旧 r<=0 在 u=0.25 会错成 0；现须得 1
  assert.equal(pickIndexByWeights(weights, () => 0.25), 1);
  assert.equal(pickIndexByWeights(weights, () => 0.5), 2);
  assert.equal(pickIndexByWeights(weights, () => 0.75), 3);
});

test('全 0 权重仍有空位 → 均匀兜底（P2）', () => {
  const n = 5;
  const weights = [0, 0, 0, 0, 0];
  const counts = new Array(n).fill(0);
  // 注入均匀序列，覆盖每个下标
  for (let k = 0; k < n; k += 1) {
    const u = (k + 0.5) / n; // 落在第 k 桶中间
    const idx = pickIndexByWeights(weights, () => u);
    assert.equal(idx, k, `全 0 兜底 u=${u} 应得下标 ${k}`);
    counts[idx] += 1;
  }
  assert.ok(counts.every((c) => c === 1), '全 0 权重应均匀覆盖每个候选');

  // 运行时：全 0 仍能 hop（不卡死）
  const hops = hopTrace(7, (w) => {
    w.setBranchPreference('texture', [0, 0, 0, 0, 0]);
  });
  assert.ok(hops.length >= 20, `全 0 权重仍应能选枝，实 ${hops.length}`);
  const uniq = new Set(hops);
  assert.ok(uniq.size >= 2, '全 0 兜底应能落到多个枝');
});

test('conductor 接线效果：按 tensionBranchBias 公式写权重后 hop 分布单调响应', () => {
  // 不改 agent.js：直接按 conductor 同款公式对 world 写权重，验证可闻偏置效果
  const bias = CONFIG.harmony.tensionBranchBias;
  const k = CONFIG.harmony.skeletonBranches;
  const weightsForTension = (tension) => {
    const t = Math.max(0, Math.min(1, tension));
    const colorW = bias.colorWeightAt0 + (bias.colorWeightAt1 - bias.colorWeightAt0) * t;
    return CONFIG.tree.branches.map((_, i) => (i < k ? bias.skeletonWeight : colorW));
  };

  const at0 = hopTrace(77, (w) => w.setBranchPreference('texture', weightsForTension(0)));
  const at1 = hopTrace(77, (w) => w.setBranchPreference('texture', weightsForTension(1)));
  const uniform = hopTrace(77, (w) => w.setBranchPreference('texture', [1, 1, 1, 1, 1]));

  assert.ok(at0.length >= 40 && at1.length >= 40 && uniform.length >= 40);
  const highShare = (hops) => hops.filter((id) => id >= k).length / hops.length;
  const s0 = highShare(at0);
  const s1 = highShare(at1);
  const su = highShare(uniform);
  // tension=0 → 高枝近禁，显著低于均匀；tension=1 → 高枝抬升，高于 tension=0
  assert.ok(s0 < su - 0.1, `tension=0 高枝占比应低于均匀：t0=${s0.toFixed(2)} uni=${su.toFixed(2)}`);
  assert.ok(s1 > s0 + 0.15, `tension 升高高枝占比应上升：t0=${s0.toFixed(2)} t1=${s1.toFixed(2)}`);
});

// ---- melody 自主选枝的级进偏好（枝 id 按高度/音高升序）----

function melodyHopTrace(seed, stepPreference, species = 'melody', melodyPreference = 0.7) {
  const config = structuredClone(CONFIG);
  config.species.melody.stepPreference = melodyPreference;
  config.trees = [{ id: species, species, xOffset: 0, birdCount: 1, registerOffset: 0 }];
  if (stepPreference === undefined) delete config.species[species].stepPreference;
  else config.species[species].stepPreference = stepPreference;
  config.species[species].fidelity = 0;
  config.species[species].dwellBeats = 0.05;
  config.species[species].dwellJitter = 0;
  config.species[species].switchQuota = 500;
  config.species[species].activityBars = [[0, 40]];
  config.species[species].monophonyBounceProb = 0;
  config.species[species].returnBranchProbability = 0;
  config.birds.flightBaseSeconds = 0.01;
  config.birds.flightJitter = 0;
  config.birds.energyHopFloor = 0;
  config.tempo.barsPerDay = 40;
  config.agent.densityTiers = { sparse: 1, normal: 1, full: 1 };
  const world = createWorld({ config, rng: mulberry32(seed) });
  const hops = [];
  world.on('perch', (event) => {
    if (event.cause === 'hop') hops.push(event.branchId);
  });
  for (let i = 0; i < 7000 && hops.length < 180; i += 1) world.tick(1 / 30);
  return hops;
}

function adjacentShare(hops) {
  let adjacent = 0;
  for (let i = 1; i < hops.length; i += 1) {
    if (Math.abs(hops[i] - hops[i - 1]) === 1) adjacent += 1;
  }
  return adjacent / Math.max(1, hops.length - 1);
}

test('melody stepPreference=0 与缺省旧实现逐 tick 选枝一致', () => {
  const omitted = melodyHopTrace(711, undefined);
  const disabled = melodyHopTrace(711, 0);
  assert.ok(omitted.length >= 100, `应采到足够 hop，实 ${omitted.length}`);
  assert.deepEqual(disabled, omitted);
});

test('melody stepPreference 增强时，相邻枝落点占比单调上升', () => {
  const off = melodyHopTrace(712, 0);
  const configured = melodyHopTrace(712, 0.7);
  const strongest = melodyHopTrace(712, 1);
  const shares = [off, configured, strongest].map(adjacentShare);
  assert.ok(
    shares[1] > shares[0] + 0.08 && shares[2] >= shares[1],
    `相邻占比应随偏好增强：off=${shares[0].toFixed(2)} p=.7=${shares[1].toFixed(2)} p=1=${shares[2].toFixed(2)}`,
  );
});

test('melody stepPreference 不改变其他物种的自主选枝序列', () => {
  const baseline = melodyHopTrace(713, undefined, 'texture', 0);
  const texture = melodyHopTrace(713, undefined, 'texture', 1);
  assert.deepEqual(texture, baseline);
});

test('melody stepPreference 不改写 manual/user 指定落枝', () => {
  const config = structuredClone(CONFIG);
  config.species.melody.stepPreference = 1;
  const world = createWorld({ config, rng: () => 0.5 });
  const melody = world.getSnapshot().trees.find((tree) => tree.id === 'melody');
  const bird = melody.birds.find((entry) => entry.state === 'flying') ?? melody.birds[0];
  if (bird.state === 'perched') world.unperchBird(bird.id);
  assert.equal(world.perchBird(bird.id, 4), true);
  assert.equal(world.getSnapshot().birds.find((entry) => entry.id === bird.id).branchId, 4);
  world.unperchBird(bird.id);
  const placed = world.userPlaceOnBranch('melody', 0);
  assert.ok(placed);
  assert.equal(placed.branchId, 0);
});
