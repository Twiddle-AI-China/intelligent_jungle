import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS,
  createDayObserver,
  deviationReport,
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
