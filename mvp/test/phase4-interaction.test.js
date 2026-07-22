// Phase 4：USER 接管 + user 事件源 + zoom 视口状态机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { attachPipelineConductor } from '../src/agent.js';
import { computeTreeLayout, createRenderer } from '../src/renderer.js';
import { computeSceneLayout } from '../src/scene-layout.js';
import { createDayObserver } from '../src/economy.js';
import { CONFIG } from '../src/config.js';
import { mulberry32, advanceTo } from './helpers.js';

test('user 事件入生态统计：cause:user 计入换枝与驻留样本', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const treeId = 'pad';
  const observer = createDayObserver(CONFIG.economy.prefs.pad);
  world.on('perch', (e) => { if (e.treeId === treeId) observer.feed({ ...e, event: 'perch' }); });
  world.on('unperch', (e) => { if (e.treeId === treeId) observer.feed({ ...e, event: 'unperch' }); });

  world.setTreeControl(treeId, 'USER');
  const placed = world.userPlaceOnBranch(treeId, 2);
  assert.ok(placed?.birdId != null);
  const snap = world.getSnapshot();
  const bird = snap.birds.find((b) => b.id === placed.birdId);
  assert.equal(bird.state, 'perched');
  assert.equal(bird.branchId, 2);
  world.tick(0.4);
  assert.equal(world.userShooBird(placed.birdId), true);
  const day = observer.finishDay();
  assert.ok(day.branchChanges >= 1, 'user 落枝应计入换枝');
  assert.ok(day.dwellSamples >= 1 && day.meanDwell > 0, 'user 离枝应计入驻留');
});

test('满枝驱逐：踢走驻留最久者、负载不超容量、观测只+1换枝（T35 P0/P1）', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const treeId = 'melody'; // maxCohortPerBranch = 1
  const cap = CONFIG.species.melody.maxCohortPerBranch;
  assert.equal(cap, 1);
  world.setTreeControl(treeId, 'USER');

  const observer = createDayObserver(CONFIG.economy.prefs.melody);
  world.on('perch', (e) => { if (e.treeId === treeId) observer.feed({ ...e, event: 'perch' }); });
  world.on('unperch', (e) => { if (e.treeId === treeId) observer.feed({ ...e, event: 'unperch' }); });

  const branchId = 0;
  const first = world.userPlaceOnBranch(treeId, branchId);
  assert.ok(first?.birdId != null);
  // 拉长首鸟驻留，确保它是「最久者」
  for (let i = 0; i < 30; i += 1) world.tick(1 / 30);
  const before = observer.snapshot();
  const dwellBefore = world.getSnapshot().birds.find((b) => b.id === first.birdId).dwellTime;
  assert.ok(dwellBefore > 0, '首鸟应已累计驻留');

  const flyingBefore = world.getSnapshot().trees.find((t) => t.id === treeId).birds
    .filter((b) => b.state === 'flying');
  assert.ok(flyingBefore.length >= 1, '满枝驱逐用例需要另有 flying 候选');

  const events = [];
  const offPerch = world.on('perch', (e) => { if (e.treeId === treeId) events.push({ type: 'perch', ...e }); });
  const offUnperch = world.on('unperch', (e) => { if (e.treeId === treeId) events.push({ type: 'unperch', ...e }); });

  const second = world.userPlaceOnBranch(treeId, branchId);
  offPerch();
  offUnperch();

  assert.equal(second.replaced, true);
  assert.equal(second.evictedId, first.birdId, '应踢走驻留最久的首鸟');
  assert.notEqual(second.birdId, first.birdId, '新落枝应是另一只鸟');
  assert.equal(
    world.getSnapshot().birds.filter((b) => b.treeId === treeId && b.state === 'perched' && b.branchId === branchId).length,
    cap,
    '枝负载不得超过容量',
  );
  const evicted = world.getSnapshot().birds.find((b) => b.id === first.birdId);
  assert.equal(evicted.state, 'flying', '被踢者应离枝');
  assert.equal(
    world.getSnapshot().birds.find((b) => b.id === second.birdId).branchId,
    branchId,
  );

  // 一次替换 = 1×unperch(victim) + 1×perch(new)；换枝计数只在 perch(user) 上 +1
  assert.equal(events.filter((e) => e.type === 'unperch').length, 1);
  assert.equal(events.filter((e) => e.type === 'perch').length, 1);
  assert.equal(events.find((e) => e.type === 'unperch').birdId, first.birdId);
  assert.equal(events.find((e) => e.type === 'perch').birdId, second.birdId);
  const after = observer.snapshot();
  assert.equal(after.branchChanges, before.branchChanges + 1, '替换观测只多一条换枝');
});

test('满枝+flying 不超员：pad cap=3 时第 4 只挤入会驱逐最久者', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const treeId = 'pad';
  const cap = CONFIG.species.pad.maxCohortPerBranch;
  assert.equal(cap, 3);
  world.setTreeControl(treeId, 'USER');
  const branchId = 2;
  const placed = [];
  for (let i = 0; i < cap; i += 1) {
    const r = world.userPlaceOnBranch(treeId, branchId);
    assert.ok(r && !r.same);
    placed.push(r.birdId);
    for (let t = 0; t < 10 * (cap - i); t += 1) world.tick(1 / 30); // 越早落的 dwell 越长
  }
  const longestId = placed[0];
  const longestDwell = world.getSnapshot().birds.find((b) => b.id === longestId).dwellTime;
  for (const id of placed.slice(1)) {
    assert.ok(world.getSnapshot().birds.find((b) => b.id === id).dwellTime < longestDwell);
  }
  const fourth = world.userPlaceOnBranch(treeId, branchId);
  assert.equal(fourth.replaced, true);
  assert.equal(fourth.evictedId, longestId);
  assert.equal(
    world.getSnapshot().birds.filter((b) => b.treeId === treeId && b.state === 'perched' && b.branchId === branchId).length,
    cap,
  );
  assert.equal(world.getSnapshot().birds.find((b) => b.id === longestId).state, 'flying');
});

test('USER 档跳过 flock 计划/变异，换季迁移仍可发生', () => {
  const CFG = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 2 } };
  const world = createWorld({ config: CFG, rng: mulberry32(3) });
  world.setTreeControl('pad', 'USER');
  world.setTreeControl('melody', 'AGENT');
  const applies = [];
  attachPipelineConductor(world, {
    config: CFG,
    rng: mulberry32(4),
    onApply: (e) => applies.push(e),
  });
  // 钉住 pad 家枝，确认 USER 黎明不写变异
  const padBefore = world.getSnapshot().trees.find((t) => t.id === 'pad').birds
    .map((b) => [b.id, b.homeBranch]);
  advanceTo(world, 2, 0.02);
  const day2 = applies.find((e) => e.day === 2);
  assert.equal(day2.plans.pad.source, 'USER');
  assert.deepEqual(day2.plans.pad.plan.mutations, []);
  assert.notEqual(day2.plans.melody.source, 'USER', 'AGENT 树仍走规则/LLM');
  const padAfter = world.getSnapshot().trees.find((t) => t.id === 'pad').birds
    .map((b) => [b.id, b.homeBranch]);
  assert.deepEqual(padAfter, padBefore, 'USER 树黎明变异不得改写 homeBranch');
});

test('档位唯一来源=zoom：特写树 USER、其余 AGENT；退出全 AGENT（不重置家枝）', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0.5 });
  const ids = CONFIG.trees.map((t) => t.id);
  // 模拟 main.syncControlWithFocus：唯一写入路径
  const sync = (focusId) => {
    for (const id of ids) {
      if (id === focusId) world.setTreeControl(id, 'USER');
      else if (world.getTreeControl(id) === 'USER') world.releaseTreeControl(id);
      else world.setTreeControl(id, 'AGENT');
    }
  };
  const homesBefore = world.getSnapshot().trees.find((t) => t.id === 'melody').birds
    .map((b) => [b.id, b.homeBranch]);
  const targetBranch = homesBefore.every(([, h]) => h !== 4) ? 4 : 1;
  sync('melody');
  assert.equal(world.getTreeControl('melody'), 'USER');
  assert.ok(ids.filter((id) => id !== 'melody').every((id) => world.getTreeControl(id) === 'AGENT'));

  const placed = world.userPlaceOnBranch('melody', targetBranch);
  assert.ok(placed?.birdId != null);
  const homesPlaced = world.getSnapshot().trees.find((t) => t.id === 'melody').birds
    .map((b) => [b.id, b.homeBranch]);
  assert.equal(
    homesPlaced.find(([id]) => id === placed.birdId)?.[1],
    targetBranch,
    '用户摆鸟应写 homeBranch',
  );

  sync(null); // 回退全窗口
  assert.ok(ids.every((id) => world.getTreeControl(id) === 'AGENT'));
  const homesAfter = world.getSnapshot().trees.find((t) => t.id === 'melody').birds
    .map((b) => [b.id, b.homeBranch]);
  assert.deepEqual(homesAfter, homesPlaced, '回 AGENT 不得重置用户家枝');
});

test('zoom 状态机：特写放大焦点树、退出回 2×2；hitTest 枝/鸟', () => {
  const focus = computeTreeLayout(CONFIG.trees, 1280, 800, { focusTreeId: 'bass' });
  assert.equal(focus[0].id, 'bass');
  assert.equal(focus[0].focused, true);
  assert.ok(focus[0].cellWidth > focus[1].cellWidth, '焦点树主舞台更宽');
  assert.equal(focus.filter((t) => t.focused).length, 1);

  const grid = computeTreeLayout(CONFIG.trees, 1280, 800);
  assert.deepEqual(grid.map(({ row, col }) => [row, col]), [[0, 0], [0, 1], [1, 0], [1, 1]]);

  const noop = () => {};
  const canvas = { width: 800, height: 600, getContext() { return fakeCtx; } };
  const fakeCtx = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return canvas;
      if (typeof prop === 'string' && prop.startsWith('create')) return () => fakeCtx;
      return noop;
    },
    set: () => true,
  });
  canvas.getContext = () => fakeCtx;
  const originalImage = globalThis.Image;
  globalThis.Image = class { set src(_) { /* no load */ } };
  try {
    const renderer = createRenderer(canvas, CONFIG);
    const world = createWorld({ config: CONFIG, rng: () => 0.5 });
    world.setTreeControl('pad', 'USER');
    const placed = world.userPlaceOnBranch('pad', 1);
    assert.equal(renderer.setFocusTree('pad'), 'pad');
    assert.equal(renderer.getFocusTree(), 'pad');
    renderer.render({ ...world.getSnapshot(), season: 'spring' });
    // 单树场景坐标（旧 2×2 特写坐标已随单树重构迁移；见 scene-layout.test.js）。
    // 命中点取枝梢侧（远离栖鸟槽位），语义不变：点枝返回该枝。
    const scene = computeSceneLayout(CONFIG.trees, 800, 600, {
      viewportY: renderer.getViewportY(),
      focusTreeId: 'pad',
    });
    const padLayout = scene.find((entry) => entry.id === 'pad');
    const branch = padLayout.branchPoints[1];
    const hitBranch = renderer.hitTest(branch.x + padLayout.side * branch.span * 0.4, branch.y);
    assert.equal(hitBranch?.type, 'branch');
    assert.equal(hitBranch?.treeId, 'pad');
    assert.equal(hitBranch?.branchId, 1);
    assert.ok(placed.birdId != null);
    assert.equal(renderer.toggleFocusTree('pad'), null);
    assert.equal(renderer.getFocusTree(), null);
  } finally {
    if (originalImage === undefined) delete globalThis.Image;
    else globalThis.Image = originalImage;
  }
});

test('USER 树冻结自主换枝：tick 后用户栖位保持', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(9) });
  world.setTreeControl('melody', 'USER');
  const placed = world.userPlaceOnBranch('melody', 3);
  assert.ok(placed);
  for (let i = 0; i < 120; i += 1) world.tick(1 / 30);
  const bird = world.getSnapshot().birds.find((b) => b.id === placed.birdId);
  assert.equal(bird.state, 'perched');
  assert.equal(bird.branchId, 3);
});

test('USER 清空后释放：下一拍恢复 activeToday/homeBranch，不等日结', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(901) });
  const treeId = 'pad';
  // 先让开局归巢完成，得到稳定的 Agent active pattern。
  for (let i = 0; i < 180; i += 1) world.tick(1 / 30);
  world.setTreeControl(treeId, 'USER');
  const beforeClear = world.getSnapshot().trees.find((tree) => tree.id === treeId);
  const activeHomes = new Map(beforeClear.birds
    .filter((bird) => bird.activeToday)
    .map((bird) => [bird.id, bird.homeBranch]));
  assert.ok(activeHomes.size > 0, '用例需要已配置的 active pattern');
  for (const bird of beforeClear.birds.filter((entry) => entry.state === 'perched')) {
    assert.equal(world.userShooBird(bird.id), true);
  }
  assert.equal(
    world.getSnapshot().trees.find((tree) => tree.id === treeId).perchedTotal,
    0,
    '用户已清空声部',
  );

  const dayBefore = world.getSnapshot().day;
  const resumeEvents = [];
  const dawnEvents = [];
  let beforeDawnCalls = 0;
  world.on('agent-resume', (event) => resumeEvents.push(event));
  world.on('dawn', (event) => dawnEvents.push(event));
  world.onBeforeDawn(() => { beforeDawnCalls += 1; });
  assert.equal(world.releaseTreeControl(treeId), true);
  assert.equal(world.getTreeControl(treeId), 'AGENT');

  const beatSeconds = 60 / world.getSnapshot().bpm;
  const now = world.getSnapshot().simTime;
  const nextBeat = (Math.floor((now + 1e-9) / beatSeconds) + 1) * beatSeconds;
  const beforeBeat = Math.max(0, nextBeat - now - 1 / 120);
  if (beforeBeat > 0) world.tick(beforeBeat);
  assert.equal(
    world.getSnapshot().trees.find((tree) => tree.id === treeId).perchedTotal,
    0,
    '下一拍前不应提前恢复',
  );

  world.tick(1 / 60);
  const resumed = world.getSnapshot().trees.find((tree) => tree.id === treeId);
  const sounding = resumed.birds.filter((bird) => bird.state === 'perched');
  assert.ok(sounding.length > 0, '下一拍应重新落枝发声');
  assert.ok(sounding.every((bird) => activeHomes.get(bird.id) === bird.branchId), '应恢复各自 homeBranch');
  assert.equal(world.getSnapshot().day, dayBefore, '释放不得提前结算当日');
  assert.equal(dawnEvents.length, 0, '释放不得触发黎明/日结');
  assert.equal(beforeDawnCalls, 0, '释放不得调用 Agent/LLM 所在的黎明钩子');
  assert.equal(resumeEvents.length, 1);
});

test('释放后在下一拍前重新 USER 接管，取消待恢复动作', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(902) });
  world.setTreeControl('melody', 'USER');
  const placed = world.userPlaceOnBranch('melody', 2);
  assert.ok(placed);
  world.userShooBird(placed.birdId);
  world.releaseTreeControl('melody');
  world.setTreeControl('melody', 'USER');
  world.tick(60 / world.getSnapshot().bpm + 0.01);
  assert.equal(world.getTreeControl('melody'), 'USER');
  assert.equal(world.getSnapshot().birds.find((bird) => bird.id === placed.birdId).state, 'flying');
});
