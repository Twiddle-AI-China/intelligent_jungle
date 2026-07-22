import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvivalShadow, settleSurvivalDay } from '../src/survival-shadow.js';

const healthy = {
  sequenceOnsetCount: 8,
  intervalRegularity: 0.8,
  harmonyScore: 0.9,
  crossVoice: 0.8,
  score: 0.85,
  clipWarn: false,
};

test('三维 shadow 只用日结事实，确定性地产生有界资源与简短依据', () => {
  const input = { day: 3, trees: { pad: healthy } };
  const first = settleSurvivalDay(input);
  const second = settleSurvivalDay(input);
  assert.deepEqual(second, first);
  assert.equal(first.source, 'deterministic-shadow');
  assert.equal(first.trees.pad.stamina.value, 60, '未观测潜空间探索时体力不受 Sequence 重复扣减');
  assert.ok(first.trees.pad.health.value > 59, '安全电平与和谐会缓冲适度音序消耗');
  assert.ok(first.trees.pad.catch.value > 60, '规律且协作的 Sequence 增加捕获');
  for (const key of ['stamina', 'health', 'catch']) {
    const resource = first.trees.pad[key];
    assert.ok(resource.value >= 0 && resource.value <= 100);
    assert.ok(resource.terms.length <= 5);
    assert.ok(resource.terms.every((term) => typeof term.label === 'string' && Number.isFinite(term.delta)));
  }
});

test('削波只能伤害生命；潜空间无观测为豁免而非零探索', () => {
  const clean = settleSurvivalDay({ day: 1, trees: { texture: healthy } });
  const clipped = settleSurvivalDay({
    day: 1,
    trees: { texture: { ...healthy, clipWarn: true } },
  });
  assert.ok(clipped.trees.texture.health.value < clean.trees.texture.health.value);
  assert.equal(clipped.trees.texture.catch.value, clean.trees.texture.catch.value);
  assert.ok(clean.trees.texture.flags.includes('exploration-unobserved'));
  assert.equal(clean.trees.texture.stamina.terms.some((term) => term.key === 'latentExploration'), false);
});

test('USER 日冻结三项资源；交回后从旧存量继续结算', () => {
  const ledger = createSurvivalShadow({ treeIds: ['melody'] });
  const frozen = ledger.settle({
    day: 1, trees: { melody: healthy }, controls: { melody: 'USER' },
  });
  assert.deepEqual(
    ['stamina', 'health', 'catch'].map((key) => frozen.trees.melody[key].value),
    [60, 60, 60],
  );
  assert.ok(frozen.trees.melody.flags.includes('user-frozen'));
  const resumed = ledger.settle({ day: 2, trees: { melody: healthy } });
  assert.ok(resumed.trees.melody.catch.value > 60);
  assert.equal(ledger.history().length, 2);
});

test('极端连续日也不会越过 0..100，delta 单日不超过 8', () => {
  const ledger = createSurvivalShadow({ treeIds: ['bass'] });
  let snapshot;
  for (let day = 1; day <= 64; day += 1) {
    snapshot = ledger.settle({
      day,
      trees: {
        bass: {
          sequenceOnsetCount: 16, intervalRegularity: 0,
          harmonyScore: 0, crossVoice: 0, score: 0, clipWarn: true,
          latentExploration: 1,
        },
      },
    });
  }
  for (const key of ['stamina', 'health', 'catch']) {
    assert.ok(snapshot.trees.bass[key].value >= 0 && snapshot.trees.bass[key].value <= 100);
    assert.ok(Math.abs(snapshot.trees.bass[key].delta) <= 8);
  }
});

test('稳定健康行为连续 64 日不会把任一资源顶死或耗尽', () => {
  const ledger = createSurvivalShadow({ treeIds: ['pad'] });
  let snapshot;
  for (let day = 1; day <= 64; day += 1) {
    snapshot = ledger.settle({ day, trees: { pad: healthy } });
  }
  for (const key of ['stamina', 'health', 'catch']) {
    assert.ok(snapshot.trees.pad[key].value > 10 && snapshot.trees.pad[key].value < 95,
      `${key} 不应在普通健康行为下坍缩到边界`);
  }
});
