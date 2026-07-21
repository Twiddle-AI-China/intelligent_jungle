import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS,
  createDayObserver,
  deviationReport,
  scoreBreakdown,
  scoreDay,
  relativeLevelDb,
  loudnessBalanceFromLevels,
  clipWarnFromLevels,
} from '../src/economy.js';
import { CONFIG } from '../src/config.js';

const simplePrefs = {
  branchChanges: { lo: 2, hi: 4, slope: 0.25 },
  meanDwell: { lo: 10, hi: 20, slope: 0.1 },
  cohortSize: { lo: 1, hi: 2, slope: 0.5 },
};

const loudPrefs = {
  ...simplePrefs,
  loudnessBalance: { lo: -24, hi: -3, slope: 1 / 12 },
  weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1, loudnessBalance: 0.5 },
};

test('偏好带内与边界值都是满分', () => {
  assert.equal(scoreDay({ branchChanges: 3, meanDwell: 15, cohortSize: 2 }, simplePrefs), 1);
  assert.equal(scoreDay({ branchChanges: 2, meanDwell: 20, cohortSize: 1 }, simplePrefs), 1);
});

test('带外按可配斜率线性衰减，并在零分处夹断', () => {
  const observed = { branchChanges: 1, meanDwell: 25, cohortSize: 4 };
  // 分项：0.75、0.5、0；默认等权。loudnessBalance 缺省 → 豁免，仍三维。
  assert.ok(Math.abs(scoreDay(observed, simplePrefs) - 1.25 / 3) < 1e-12);
  assert.equal(scoreDay({ branchChanges: 100, meanDwell: 200, cohortSize: 20 }, simplePrefs), 0);
});

test('显示分解暴露实测/偏好带/衰减分，总分与 scoreDay 同口径', () => {
  const observed = { branchChanges: 1, meanDwell: 15, cohortSize: 4 };
  const breakdown = scoreBreakdown(observed, simplePrefs);
  assert.deepEqual(
    Object.keys(breakdown.metrics),
    ['branchChanges', 'meanDwell', 'cohortSize', 'loudnessBalance', 'crossVoice'],
  );
  assert.deepEqual(breakdown.metrics.branchChanges, {
    value: 1, lo: 2, hi: 4, slope: 0.25, weight: 1,
    direction: 'low', amount: 1, score: 0.75,
  });
  assert.equal(breakdown.metrics.meanDwell.score, 1);
  assert.equal(breakdown.metrics.cohortSize.score, 0);
  assert.equal(breakdown.metrics.loudnessBalance.direction, 'exempt');
  assert.equal(breakdown.metrics.loudnessBalance.score, null);
  assert.equal(breakdown.metrics.crossVoice.direction, 'exempt');
  assert.equal(breakdown.metrics.crossVoice.score, null);
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
  assert.equal(report.loudnessBalance, 'exempt');
  assert.equal(report.crossVoice, 'exempt');
  assert.deepEqual(report.magnitude, {
    branchChanges: 1, meanDwell: 0, cohortSize: 2, loudnessBalance: 0, crossVoice: 0,
  });
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

// ---- R1 电平入分：第四维 loudnessBalance ----

test('config.economy.loudness 提供 kimi2 锚阈值与中等权重', () => {
  const loud = CONFIG.economy.loudness;
  assert.equal(loud.relativeQuietDb, -24);
  assert.equal(loud.relativeLoudDb, -3);
  assert.equal(loud.clipPeakWarn, 0.9);
  assert.ok(loud.weight > 0 && loud.weight < 1, '响度权重中等，不主导');
  assert.equal(CONFIG.economy.prefs.texture.loudnessBalance.lo, -24);
  assert.equal(CONFIG.economy.prefs.pad.weights.loudnessBalance, loud.weight);
});

test('relativeLevelDb：相对最响锚；无锚 → null', () => {
  assert.equal(relativeLevelDb(0.2, 0.4), 20 * Math.log10(0.5));
  assert.equal(relativeLevelDb(0.4, 0.4), 0);
  assert.equal(relativeLevelDb(0, 0.4), -120);
  assert.equal(relativeLevelDb(0.1, 0), null);
});

test('loudnessBalanceFromLevels：过静扣分、过响扣分、带内满分', () => {
  // 锚 pad=0.4；texture 相对 ≈ -36dB（过静）；bass ≈ -6dB（带内）；pad=0dB（过响）
  const levels = {
    pad: { rms: 0.4, peak: 0.96, samples: 100 },
    bass: { rms: 0.2, peak: 0.5, samples: 100 },
    melody: { rms: 0.05, peak: 0.2, samples: 100 },
    texture: { rms: 0.006, peak: 0.05, samples: 100 },
  };
  const padDb = loudnessBalanceFromLevels(levels, 'pad');
  const bassDb = loudnessBalanceFromLevels(levels, 'bass');
  const textureDb = loudnessBalanceFromLevels(levels, 'texture');
  assert.equal(padDb, 0);
  assert.ok(bassDb > -24 && bassDb < -3, `bass 应带内，得 ${bassDb}`);
  assert.ok(textureDb < -24, `texture 应过静，得 ${textureDb}`);

  const base = { branchChanges: 3, meanDwell: 15, cohortSize: 2 };
  const padBreak = scoreBreakdown({ ...base, loudnessBalance: padDb }, loudPrefs);
  const bassBreak = scoreBreakdown({ ...base, loudnessBalance: bassDb }, loudPrefs);
  const texBreak = scoreBreakdown({ ...base, loudnessBalance: textureDb }, loudPrefs);

  assert.equal(padBreak.metrics.loudnessBalance.direction, 'high', '最响声部相对 0dB > -3 → 过响');
  assert.ok(padBreak.metrics.loudnessBalance.score < 1);
  assert.equal(bassBreak.metrics.loudnessBalance.direction, 'within');
  assert.equal(bassBreak.metrics.loudnessBalance.score, 1);
  assert.equal(texBreak.metrics.loudnessBalance.direction, 'low', '过静');
  assert.ok(texBreak.metrics.loudnessBalance.score < 1);
  assert.ok(clipWarnFromLevels(levels, 'pad', 0.9), 'pad peak>0.9 削波告警');
  assert.equal(clipWarnFromLevels(levels, 'bass', 0.9), false);
});

test('无电平数据 → loudnessBalance 豁免，不误扣为 0 分', () => {
  const base = { branchChanges: 3, meanDwell: 15, cohortSize: 2 };
  const empty = {
    pad: { rms: 0, peak: 0, samples: 0 },
    bass: { rms: 0, peak: 0, samples: 0 },
    melody: { rms: 0, peak: 0, samples: 0 },
    texture: { rms: 0, peak: 0, samples: 0 },
  };
  assert.equal(loudnessBalanceFromLevels(null, 'pad'), null);
  assert.equal(loudnessBalanceFromLevels(empty, 'pad'), null);
  assert.equal(loudnessBalanceFromLevels(undefined, 'texture'), null);

  const withNull = scoreDay({ ...base, loudnessBalance: null }, loudPrefs);
  const without = scoreDay(base, loudPrefs);
  assert.equal(withNull, 1, '三行为维满分时豁免响度仍总分 1');
  assert.equal(without, 1);
  assert.equal(withNull, without);

  // 若误把 null 当 0：0 相对锚会判过响并扣分——断言不会发生
  const mistakenZero = scoreDay({ ...base, loudnessBalance: 0 }, loudPrefs);
  assert.ok(mistakenZero < 1, '对照：数值 0（最响）会过响扣分');
  assert.ok(withNull > mistakenZero, 'null 豁免分必须高于误判 0');
});

test('四维重归一：响度权重中等，总分仍落在 [0,1]', () => {
  const base = { branchChanges: 3, meanDwell: 15, cohortSize: 2 }; // 三行为维满分
  const within = scoreDay({ ...base, loudnessBalance: -12 }, loudPrefs);
  const quiet = scoreDay({ ...base, loudnessBalance: -36 }, loudPrefs);
  const loud = scoreDay({ ...base, loudnessBalance: 0 }, loudPrefs);
  assert.equal(within, 1);
  assert.ok(quiet < 1 && quiet > 0);
  assert.ok(loud < 1 && loud > 0);
  // 权重 0.5 / 总 3.5：过响 amount=3、slope=1/12 → 响度分 0.75
  // total = (1+1+1+0.75*0.5) / 3.5 = 3.375/3.5
  assert.ok(Math.abs(loud - 3.375 / 3.5) < 1e-12);
  assert.ok(quiet >= 0 && quiet <= 1);
  assert.ok(loud >= 0 && loud <= 1);
});

// ---- Track B：跨声部生态位第五维 crossVoice ----

test('config.economy.crossVoice 提供错峰带与发声偏置键', () => {
  const cv = CONFIG.economy.crossVoice;
  assert.equal(cv.lo, 0.05);
  assert.equal(cv.weight, 0.75);
  assert.equal(cv.suppressBias, 0.5);
  assert.equal(cv.suppressCount, 1);
  assert.equal(cv.conflictThreshold, 0.8);
  assert.equal('suppressExclude' in cv, false);
  assert.equal(CONFIG.economy.prefs.pad.weights.crossVoice, cv.weight);
});

test('createCrossVoiceObserver：错峰分散高分、同刻扎堆低分；无发声 null 豁免', async () => {
  const { createCrossVoiceObserver } = await import('../src/economy.js');
  const empty = createCrossVoiceObserver({ treeIds: ['a', 'b', 'c', 'd'], bpm: 60 });
  const blankDay = empty.finishDay({ dayLength: 4 });
  assert.equal(blankDay.crossVoice, null);
  assert.equal(blankDay.biasHints.a, 'hold');

  // 半拍 bin @60BPM = 0.5s；交错长栖 → 多数 bin 仅 1 声部
  const staggered = createCrossVoiceObserver({ treeIds: ['a', 'b', 'c', 'd'], bpm: 60 });
  staggered.feed([
    { event: 'perch', treeId: 'a', time: 0.0 },
    { event: 'unperch', treeId: 'a', time: 1.0 },
    { event: 'perch', treeId: 'b', time: 1.0 },
    { event: 'unperch', treeId: 'b', time: 2.0 },
    { event: 'perch', treeId: 'c', time: 2.0 },
    { event: 'unperch', treeId: 'c', time: 3.0 },
  ]);
  const good = staggered.finishDay({ dayStart: 0, dayLength: 3 });
  assert.ok(good.crossVoice > 0.5, `交错应高分，得 ${good.crossVoice}`);

  const piled = createCrossVoiceObserver({ treeIds: ['a', 'b', 'c', 'd'], bpm: 60 });
  piled.feed([
    { event: 'perch', treeId: 'a', time: 0 },
    { event: 'perch', treeId: 'b', time: 0 },
    { event: 'perch', treeId: 'c', time: 0 },
    { event: 'perch', treeId: 'd', time: 0 },
  ]);
  const bad = piled.finishDay({ dayStart: 0, dayLength: 2 });
  assert.ok(bad.crossVoice < 0.2, `四声部同栖应低分，得 ${bad.crossVoice}`);
  assert.ok(bad.conflictRatio > 0.8);
  assert.equal(bad.biasHints.a, 'suppress');
  // 冲突期不得 encourage（否则 hoppers 加码会让 canonical 密度更差）
  assert.ok(!Object.values(bad.biasHints).includes('encourage'));
});

test('createCrossVoiceObserver：错峰改善日全部 hold，不把静音树拉回', async () => {
  const { createCrossVoiceObserver } = await import('../src/economy.js');
  // 仅两声部交错 → conflict 低、blank 低、互补高 → 甜蜜点 hold
  const obs = createCrossVoiceObserver({ treeIds: ['a', 'b', 'c', 'd'], bpm: 60 });
  obs.feed([
    { event: 'perch', treeId: 'a', time: 0 },
    { event: 'unperch', treeId: 'a', time: 1 },
    { event: 'perch', treeId: 'b', time: 1 },
    { event: 'unperch', treeId: 'b', time: 2 },
  ]);
  const day = obs.finishDay({ dayStart: 0, dayLength: 2 });
  assert.ok(day.conflictRatio < 0.5);
  assert.ok(day.blankRatio < 0.25);
  assert.deepEqual(day.biasHints, { a: 'hold', b: 'hold', c: 'hold', d: 'hold' });
});

test('createCrossVoiceObserver：连续冲突每日只 suppress 一树且轮换', async () => {
  const { createCrossVoiceObserver } = await import('../src/economy.js');
  const obs = createCrossVoiceObserver({
    treeIds: ['pad', 'melody', 'bass', 'texture'],
    bpm: 60,
    conflictThreshold: 0.8,
    suppressCount: 1,
  });
  const conflictDay = () => {
    obs.feed(['pad', 'melody', 'bass', 'texture'].map((treeId) => ({
      event: 'perch', treeId, time: 0,
    })));
    return obs.finishDay({ dayStart: 0, dayLength: 2 });
  };
  const suppressed = Array.from({ length: 4 }, () => {
    const day = conflictDay();
    const ids = Object.entries(day.biasHints).filter(([, hint]) => hint === 'suppress').map(([id]) => id);
    assert.equal(ids.length, 1);
    return ids[0];
  });
  assert.deepEqual(suppressed, ['pad', 'melody', 'bass', 'texture']);
});

test('createCrossVoiceObserver：日窗用 dayLength，不被绝对 simTime 空 bin 稀释', async () => {
  const { createCrossVoiceObserver } = await import('../src/economy.js');
  const obs = createCrossVoiceObserver({ treeIds: ['a', 'b', 'c', 'd'], bpm: 60 });
  // 模拟第 10 日：事件落在 t∈[144,160]，若误用 endTime=160 当 duration 会把前 144s 算 blank
  obs.feed([
    { event: 'perch', treeId: 'a', time: 144 },
    { event: 'perch', treeId: 'b', time: 144 },
    { event: 'perch', treeId: 'c', time: 144 },
    { event: 'perch', treeId: 'd', time: 144 },
  ]);
  const diluted = obs.finishDay({ endTime: 160 }); // 无 dayLength → 易稀释（旧 bug 路径）
  // 显式日窗
  const obs2 = createCrossVoiceObserver({ treeIds: ['a', 'b', 'c', 'd'], bpm: 60 });
  obs2.feed([
    { event: 'perch', treeId: 'a', time: 144 },
    { event: 'perch', treeId: 'b', time: 144 },
    { event: 'perch', treeId: 'c', time: 144 },
    { event: 'perch', treeId: 'd', time: 144 },
  ]);
  const correct = obs2.finishDay({ dayStart: 144, dayLength: 16, endTime: 160 });
  assert.ok(correct.conflictRatio > 0.9, `日窗冲突应高，得 ${correct.conflictRatio}`);
  assert.ok(correct.blankRatio < 0.1, `日窗 blank 应低，得 ${correct.blankRatio}`);
  assert.equal(correct.biasHints.a, 'suppress');
  // 稀释路径 blank 虚高；正确日窗 conflict 主导
  assert.ok(correct.conflictRatio > diluted.blankRatio || correct.conflictRatio >= 0.9);
});

test('crossVoice 入分：偏低扣分；null 豁免不污染', () => {
  const prefs = {
    branchChanges: { lo: 2, hi: 4, slope: 0.25 },
    meanDwell: { lo: 10, hi: 20, slope: 0.1 },
    cohortSize: { lo: 1, hi: 2, slope: 0.5 },
    crossVoice: { lo: 0.05, hi: 1, slope: 1 / 0.2 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1, crossVoice: 0.75 },
  };
  const base = { branchChanges: 3, meanDwell: 15, cohortSize: 2 };
  assert.equal(scoreDay({ ...base, crossVoice: null }, prefs), 1);
  assert.equal(scoreDay({ ...base, crossVoice: 0.5 }, prefs), 1);
  const low = scoreDay({ ...base, crossVoice: 0.01 }, prefs);
  assert.ok(low < 1 && low > 0);
  const report = deviationReport({ ...base, crossVoice: 0.01 }, prefs);
  assert.equal(report.crossVoice, 'low');
});
