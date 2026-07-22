import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLatentExplorationObserver,
  createSurvivalShadow,
  localTextureExplorationFromDay,
  settleSurvivalDay,
  SURVIVAL_RESERVE,
} from '../src/survival-shadow.js';

const healthy = {
  sequenceOnsetCount: 8,
  intervalRegularity: 0.8,
  harmonyScore: 0.9,
  crossVoice: 0.8,
  score: 0.85,
  clipWarn: false,
  latentExploration: 0.35,
};

test('生命→体力→食物→生命按固定顺序闭环且逐项可对账', () => {
  const first = settleSurvivalDay({ day: 3, trees: { pad: healthy } });
  const second = settleSurvivalDay({ day: 3, trees: { pad: healthy } });
  assert.deepEqual(second, first);
  assert.equal(first.source, 'survival-loop');
  const tree = first.trees.pad;
  assert.ok(tree.transactions.find((row) => row.id === 'branch').spent > 0);
  assert.ok(tree.transactions.find((row) => row.id === 'explore').gained > 0);
  assert.equal(tree.transactions.find((row) => row.id === 'meal').spent, 2);
  for (const key of ['health', 'stamina', 'food']) {
    const item = tree[key];
    const termTotal = item.terms.reduce((sum, term) => sum + term.delta, 0);
    assert.ok(Math.abs(termTotal - item.delta) < 0.02, `${key} tooltip 必须与 delta 对账`);
    assert.ok(item.value >= SURVIVAL_RESERVE && item.value <= 100);
  }
});

test('无潜空间观测时豁免探索转换，但仍执行夜间进食', () => {
  const result = settleSurvivalDay({
    day: 1, trees: { texture: { ...healthy, latentExploration: null } },
  }).trees.texture;
  assert.ok(result.flags.includes('exploration-unobserved'));
  assert.equal(result.stamina.terms.find((term) => term.key === 'latentExploration').delta, 0);
  assert.equal(result.food.terms.find((term) => term.key === 'nightMeal').delta, -2);
});

test('USER 日冻结三项资源；交回后从旧存量继续结算', () => {
  const ledger = createSurvivalShadow({ treeIds: ['melody'] });
  const frozen = ledger.settle({
    day: 1, trees: { melody: healthy }, controls: { melody: 'USER' },
  });
  assert.deepEqual(
    ['health', 'stamina', 'food'].map((key) => frozen.trees.melody[key].value),
    [60, 60, 60],
  );
  assert.ok(frozen.trees.melody.flags.includes('user-frozen'));
  const resumed = ledger.settle({ day: 2, trees: { melody: healthy } });
  assert.notEqual(resumed.trees.melody.food.value, 60);
});

test('极端连续日也不会穿透安全储备，Master 无法把资源玩死', () => {
  const ledger = createSurvivalShadow({ treeIds: ['bass'] });
  let snapshot;
  for (let day = 1; day <= 128; day += 1) {
    snapshot = ledger.settle({
      day,
      trees: {
        bass: {
          sequenceOnsetCount: 16, intervalRegularity: 0,
          harmonyScore: 0, crossVoice: 0, clipWarn: true,
          latentExploration: 1,
        },
      },
    });
  }
  for (const key of ['health', 'stamina', 'food']) {
    assert.ok(snapshot.trees.bass[key].value >= SURVIVAL_RESERVE
      && snapshot.trees.bass[key].value <= 100);
  }
});

test('潜空间探索按 Agent/USER 来源分别限幅，一次用户横拖不会顶满全天', () => {
  const observer = createLatentExplorationObserver({ referenceDistance: 1.5 });
  observer.feed({ treeId: 'pad', position: [-1, 0], source: 'user', sent: true });
  observer.feed({ treeId: 'pad', position: [1, 0], source: 'user', sent: true });
  observer.feed({ treeId: 'pad', position: [0, 0], source: 'agent', sent: true });
  observer.feed({ treeId: 'pad', position: [1.5, 0], source: 'agent', sent: true });
  observer.feed({ treeId: 'pad', position: [9, 9], source: 'agent', sent: false });
  assert.deepEqual(observer.finishDay('pad'), {
    intensity: 1,
    distance: 3.5,
    samples: 4,
    sources: ['agent', 'user'],
    sourceDistances: { user: 2, agent: 1.5 },
  });
  const onlyUser = createLatentExplorationObserver({ referenceDistance: 1.5 });
  onlyUser.feed({ treeId: 'pad', position: [-1, 0], source: 'user', sent: true });
  onlyUser.feed({ treeId: 'pad', position: [1, 0], source: 'user', sent: true });
  assert.equal(onlyUser.finishDay('pad').intensity, 0.55);
  assert.equal(observer.finishDay('pad').intensity, null);
});

test('Jungle 本地切片变化形成独立探索证据，并受 Master drive 限幅', () => {
  const observed = {
    sequenceOnsetCount: 8, branchChangesPerLoop: 4, intervalRegularity: 0.5,
  };
  const normal = localTextureExplorationFromDay(observed, 1);
  const explore = localTextureExplorationFromDay(observed, 3);
  assert.ok(normal > 0 && normal < explore);
  assert.ok(explore <= 1);
});
