import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS,
  createDayObserver,
  deviationReport,
  scoreBreakdown,
  scoreDay,
} from '../src/economy.js';

const simplePrefs = {
  branchChanges: { lo: 2, hi: 4, slope: 0.25 },
  meanDwell: { lo: 10, hi: 20, slope: 0.1 },
  cohortSize: { lo: 1, hi: 2, slope: 0.5 },
};

test('偏好带内与边界值都是满分', () => {
  assert.equal(scoreDay({ branchChanges: 3, meanDwell: 15, cohortSize: 2 }, simplePrefs), 1);
  assert.equal(scoreDay({ branchChanges: 2, meanDwell: 20, cohortSize: 1 }, simplePrefs), 1);
});

test('带外按可配斜率线性衰减，并在零分处夹断', () => {
  const observed = { branchChanges: 1, meanDwell: 25, cohortSize: 4 };
  // 分项：0.75、0.5、0；默认等权。
  assert.ok(Math.abs(scoreDay(observed, simplePrefs) - 1.25 / 3) < 1e-12);
  assert.equal(scoreDay({ branchChanges: 100, meanDwell: 200, cohortSize: 20 }, simplePrefs), 0);
});

test('显示分解暴露实测/偏好带/衰减分，总分与 scoreDay 同口径', () => {
  const observed = { branchChanges: 1, meanDwell: 15, cohortSize: 4 };
  const breakdown = scoreBreakdown(observed, simplePrefs);
  assert.deepEqual(
    Object.keys(breakdown.metrics), ['branchChanges', 'meanDwell', 'cohortSize']);
  assert.deepEqual(breakdown.metrics.branchChanges, {
    value: 1, lo: 2, hi: 4, slope: 0.25, weight: 1,
    direction: 'low', amount: 1, score: 0.75,
  });
  assert.equal(breakdown.metrics.meanDwell.score, 1);
  assert.equal(breakdown.metrics.cohortSize.score, 0);
  assert.equal(breakdown.total, scoreDay(observed, simplePrefs));
});

test('权重可配，pad 的开放上界允许极长驻留', () => {
  const weighted = { ...simplePrefs, weights: { branchChanges: 3, meanDwell: 0, cohortSize: 0 } };
  assert.equal(scoreDay({ branchChanges: 1, meanDwell: 999, cohortSize: 99 }, weighted), 0.75);
  assert.equal(scoreDay({ branchChanges: 1, meanDwell: 600, cohortSize: 1 }, DEFAULT_PREFS.pad), 1);
});

test('四树默认偏好带使用音乐单位并覆盖 bass/texture 性格', () => {
  assert.deepEqual(Object.keys(DEFAULT_PREFS), ['melody', 'pad', 'bass', 'texture']);
  assert.equal(DEFAULT_PREFS.bass.meanDwell.lo, 16, 'bass 至少驻留一个 16 拍循环');
  assert.deepEqual(
    [DEFAULT_PREFS.texture.branchChanges.lo, DEFAULT_PREFS.texture.branchChanges.hi],
    [4, 8],
  );
  assert.equal(scoreDay({ branchChanges: 6, meanDwell: 2, cohortSize: 1 }, DEFAULT_PREFS.texture), 1);
});

test('observer 优先累计事件中的 dwellBeats', () => {
  const observer = createDayObserver();
  observer.feed({ type: 'unperch', birdId: 1, branchId: 0, dwellBeats: 4, dwellTime: 99 });
  assert.equal(observer.snapshot().meanDwell, 4);
});

test('事件数组与逐条 feed 正确累计换枝、平均驻留和同枝峰值', () => {
  const observer = createDayObserver(simplePrefs);
  observer.feed([
    { event: 'perch', birdId: 0, branchId: 1, cause: 'settle', perchedOnBranch: 1 },
    { event: 'perch', birdId: 1, branchId: 1, cause: 'settle', perchedOnBranch: 2 },
    { event: 'unperch', birdId: 0, branchId: 1, cause: 'hop', dwellTime: 4 },
  ]);
  observer.feed({ event: 'perch', birdId: 0, branchId: 2, cause: 'hop', perchedOnBranch: 1 });
  observer.feed({ type: 'unperch', birdId: 1, branchId: 1, dwellTime: 8 });
  observer.feed({ type: 'unperch', birdId: 0, branchId: 2, dwellTime: 6 });

  assert.deepEqual(observer.snapshot(), {
    branchChanges: 1,
    meanDwell: 6,
    cohortSize: 2,
    dwellSamples: 3,
  });
});

test('没有 cause 时按同鸟前后不同枝推断换枝，不把同枝再落计为换枝', () => {
  const observer = createDayObserver();
  observer.feed([
    { type: 'perch', birdId: 7, branchId: 0 },
    { type: 'unperch', birdId: 7, branchId: 0, dwellTime: 1 },
    { type: 'perch', birdId: 7, branchId: 0 },
    { type: 'unperch', birdId: 7, branchId: 0, dwellTime: 1 },
    { type: 'perch', birdId: 7, branchId: 3 },
  ]);
  assert.equal(observer.snapshot().branchChanges, 1);
});

test('偏离报告给出低/带内/高方向及同单位幅度', () => {
  const report = deviationReport({ branchChanges: 1, meanDwell: 15, cohortSize: 4 }, simplePrefs);
  assert.equal(report.branchChanges, 'low');
  assert.equal(report.meanDwell, 'within');
  assert.equal(report.cohortSize, 'high');
  assert.deepEqual(report.magnitude, { branchChanges: 1, meanDwell: 0, cohortSize: 2 });
  assert.equal(report.details.cohortSize.value, 4);
});

test('finishDay 返回日结算并复位计数器', () => {
  const observer = createDayObserver();
  observer.feed([
    { type: 'perch', birdId: 0, branchId: 1 },
    { type: 'unperch', birdId: 0, branchId: 1, dwellTime: 5 },
    { type: 'perch', birdId: 0, branchId: 2 },
    { type: 'unperch', birdId: 0, branchId: 2, dwellTime: 7 },
  ]);
  const ended = observer.finishDay();
  assert.equal(ended.branchChanges, 1);
  assert.equal(ended.meanDwell, 6);
  assert.deepEqual(observer.snapshot(), {
    branchChanges: 0,
    meanDwell: 0,
    cohortSize: 0,
    dwellSamples: 0,
  });
});

test('稳栖日无 unperch：meanDwell≈日长，pad 驻留维满分（P0-1）', () => {
  const beatsPerDay = 16;
  const observer = createDayObserver(DEFAULT_PREFS.pad, { beatsPerDay });
  // 黎明落枝后全日不动——无 unperch
  observer.feed([
    { event: 'perch', birdId: 0, branchId: 1, cause: 'settle', perchedOnBranch: 1 },
    { event: 'perch', birdId: 1, branchId: 2, cause: 'settle', perchedOnBranch: 1 },
  ]);
  const day = observer.finishDay();
  assert.equal(day.dwellSamples, 2);
  assert.equal(day.meanDwell, beatsPerDay, '无离枝样本应按全天连续栖枝记日长');
  assert.equal(day.branchChanges, 0);
  const breakdown = scoreBreakdown({
    branchChanges: day.branchChanges,
    meanDwell: day.meanDwell,
    cohortSize: day.cohortSize,
  }, DEFAULT_PREFS.pad);
  assert.equal(breakdown.metrics.meanDwell.score, 1, 'pad 稳栖日驻留维须满分');
  assert.equal(breakdown.metrics.meanDwell.direction, 'within');
});

test('settle 离枝不计驻留；openDwellBeats 与 hop 样本一并入账（P0-3）', () => {
  const observer = createDayObserver(DEFAULT_PREFS.pad, { beatsPerDay: 16 });
  observer.feed([
    { event: 'perch', birdId: 0, branchId: 0, cause: 'settle' },
    { event: 'unperch', birdId: 0, branchId: 0, cause: 'settle', dwellBeats: 99 },
    { event: 'perch', birdId: 0, branchId: 1, cause: 'hop' },
    { event: 'unperch', birdId: 0, branchId: 1, cause: 'hop', dwellBeats: 4 },
    { event: 'perch', birdId: 1, branchId: 2, cause: 'settle' },
  ]);
  const day = observer.finishDay({ openDwellBeats: [12] });
  assert.equal(day.dwellSamples, 2, '仅 hop + 开放样本');
  assert.equal(day.meanDwell, 8); // (4+12)/2
});

test('口径一致：world 与 economy 同日同树 meanDwellBeats 对齐（P0-3）', async () => {
  const { createWorld } = await import('../src/world.js');
  const { CONFIG } = await import('../src/config.js');
  const { mulberry32, advanceTo } = await import('./helpers.js');
  const beatsPerDay = CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar;
  const world = createWorld({ config: CONFIG, rng: mulberry32(7) });
  const padObs = createDayObserver(DEFAULT_PREFS.pad, { beatsPerDay });
  world.on('perch', (e) => {
    if (e.treeId === 'pad') padObs.feed({ ...e, event: 'perch' });
  });
  world.on('unperch', (e) => {
    if (e.treeId === 'pad') padObs.feed({ ...e, event: 'unperch' });
  });
  let compared = false;
  world.onBeforeDawn(({ stats }) => {
    const eco = padObs.finishDay();
    if (stats.day < 2 || compared) return;
    const tree = stats.trees.pad;
    const w = tree.meanDwellBeats;
    const e = eco.meanDwell;
    assert.ok(tree.dwellSampleCount > 0 || eco.dwellSamples > 0, '稳栖或换枝日应有样本');
    // 同日不得出现「一边远超日长、一边 0 拍」的矛盾口径
    assert.ok(!(w > beatsPerDay * 2 && e === 0), `矛盾口径 world=${w} economy=${e}`);
    assert.ok(!(e > beatsPerDay * 2 && w === 0), `矛盾口径 world=${w} economy=${e}`);
    assert.ok(w <= beatsPerDay * 2.5, `world 驻留 ${w} 不应远超日长 ${beatsPerDay}`);
    compared = true;
  });
  advanceTo(world, 4, 0.1);
  assert.ok(compared, '应至少完成一次日界对照');
});
