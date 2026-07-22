import test from 'node:test';
import assert from 'node:assert/strict';
import { runTier } from '../eval/harness.js';

// 纯数值长时 mock：不初始化 WebAudio、DOM 或神经后端。检查的不是“每天都不同”，
// 而是后 64 日仍有受控变化、没有声部冻结，也没有为了变化破坏音乐性。
test('多 seed 256 日后仍持续演化，同时保持音乐性与生存循环', () => {
  const seeds = [17, 1701, 20260720, 20260721];
  for (const seed of seeds) {
    const metrics = runTier('F', { seed, days: 256 }).metrics;
    assert.ok(metrics.sequenceJaccardDistanceLate64 >= 0.05
      && metrics.sequenceJaccardDistanceLate64 <= 0.35,
    `seed ${seed}: 后期变化不能冻结，也不能接近随机重掷`);
    assert.ok(metrics.sequenceJaccardTreeMinLate64 >= 0.04,
      `seed ${seed}: 每个声部后期都必须继续变化`);
    assert.ok(metrics.sequenceUniquePatternShareLate64 >= 0.05,
      `seed ${seed}: 每个声部后期都必须出现多个 pattern`);
    assert.ok(metrics.harmonyMeanLate64 >= 0.85,
      `seed ${seed}: 长时变化仍须保持和谐`);
    assert.ok(metrics.behaviorTreeMinLate64 >= 0.45,
      `seed ${seed}: 任一声部不能演化到生态行为失控`);
    assert.ok(metrics.activeWindowTreeMinLate64 >= 0.75,
      `seed ${seed}: 任一声部不能逐步静音`);
    assert.ok(metrics.survivalActionCoverageMinLate64 >= 0.5
      && metrics.survivalActionTransitionMinLate64 >= 0.25,
    `seed ${seed}: Master 不能稳定成单一动作`);
    assert.ok(metrics.survivalMovementShareLate64 >= 0.9,
      `seed ${seed}: 资源闭环后期仍须运转`);
    assert.ok(metrics.survivalBoundaryShare <= 0.02,
      `seed ${seed}: 资源不能长期触及安全储备`);
    assert.ok(metrics.survivalMaxPositiveCorrelation <= 0.75,
      `seed ${seed}: 三项资源不能退化成同一个健康分`);
  }
});
