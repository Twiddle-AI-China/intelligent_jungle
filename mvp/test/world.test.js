// mvp/test/world.test.js —— 事件发射正确性：落枝恰好一个 perch，跨线恰好一个 dawn/dusk，
// 以及 Phase 1.5 的内核本能（黎明归巢、夜里归栖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beatsToSeconds,
  createWorld,
  daylightFromPhase,
  densitySizeForTier,
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
  const s = advanceTo(world, 1, 0.32); // 归巢窗口+飞行预算之后
  for (const tree of s.trees) {
    const sp = CONFIG.species[tree.species];
    const perchedActive = tree.birds.filter((b) => b.activeToday && b.state === 'perched');
    const capacity = sp.maxCohortPerBranch * tree.branches.length - (sp.switchQuota > 0 ? 1 : 0);
    const expectSize = densitySizeForTier(
      tree.densityTier, tree.birds.length, capacity, CONFIG.agent.densityTiers,
    );
    assert.ok(perchedActive.length >= Math.max(1, expectSize - 1),
      `${tree.id} 归巢后活跃鸟应基本落定，实栖 ${perchedActive.length}，期望 ≥ ${expectSize - 1}`);
  }
});

test('密度档位按每树容量比例化，小群树的 sparse/normal/full 不空转', () => {
  assert.deepEqual(['sparse', 'normal', 'full'].map((tier) => densitySizeForTier(
    tier, 3, 3, CONFIG.agent.densityTiers,
  )), [1, 2, 3], 'melody/texture 三鸟群三档各自可达');
  assert.deepEqual(['sparse', 'normal', 'full'].map((tier) => densitySizeForTier(
    tier, 2, 2, CONFIG.agent.densityTiers,
  )), [0, 1, 2], 'bass 两鸟群用 0/1/2 保留三档真实差异');
  assert.deepEqual(['sparse', 'normal', 'full'].map((tier) => densitySizeForTier(
    tier, 5, 5, CONFIG.agent.densityTiers,
  )), [2, 3, 5]);
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

test('bass 只用低枝，换季批量迁移且同一生效日幂等', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0 });
  const before = world.getSnapshot().trees.find((tree) => tree.id === 'bass');
  assert.ok(before.birds.every((bird) => bird.homeBranch === 0));
  assert.equal(world.setHomeBranch(before.birds[0].id, 4), false, 'bass 不接受高枝');
  const moves = world.applySeasonChange(2);
  assert.equal(moves.length, CONFIG.trees.find((tree) => tree.id === 'bass').birdCount);
  assert.ok(world.getSnapshot().trees.find((tree) => tree.id === 'bass').birds
    .every((bird) => bird.homeBranch === 1));
  assert.deepEqual(world.applySeasonChange(2), [], '同一换季生效日不得重复迁移');
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
