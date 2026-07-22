// 生命 / 体力 / 食物闭环 ledger。
//
// 树枝活动：生命 → 体力；音色探索：体力 → 食物；夜间进食：食物 → 生命。
// 音乐事实只影响转换效率，不能凭空生成第三方分数；Master 只能选择行动强度，
// 不能自定义 delta。资源保留不可侵犯的安全储备，USER 日仍整日冻结。

export const SURVIVAL_RESOURCE_KEYS = Object.freeze(['health', 'stamina', 'food']);
export const SURVIVAL_RESERVE = 10;
const DEFAULT_VALUE = 60;
const DAILY_MEAL = 2;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const clamp01 = (value) => clamp(finite(value), 0, 1);
const round = (value, digits = 2) => Number(finite(value).toFixed(digits));

export function createLatentExplorationObserver({
  referenceDistance = 1.5,
  sourceCaps = { agent: 0.45, user: 0.55 },
} = {}) {
  const totals = new Map();
  const previous = new Map();
  const reference = Math.max(0.01, finite(referenceDistance, 1.5));

  function feed({ treeId, position, source = 'agent', mode = 'xy', sent = true } = {}) {
    if (!treeId || !sent || !Array.isArray(position) || position.length < 2) return false;
    const coords = position.map(Number);
    if (coords.some((value) => !Number.isFinite(value))) return false;
    const key = `${treeId}:${source}:${mode}`;
    const before = previous.get(key);
    previous.set(key, coords);
    const total = totals.get(treeId) ?? { samples: 0, bySource: new Map() };
    const bucket = total.bySource.get(source) ?? { distance: 0, samples: 0 };
    bucket.samples += 1;
    total.samples += 1;
    if (before?.length === coords.length) {
      bucket.distance += Math.sqrt(coords.reduce((sum, value, index) => (
        sum + (value - before[index]) ** 2
      ), 0));
    }
    total.bySource.set(source, bucket);
    totals.set(treeId, total);
    return true;
  }

  function finishDay(treeId) {
    const total = totals.get(treeId) ?? { samples: 0, bySource: new Map() };
    totals.delete(treeId);
    for (const key of [...previous.keys()]) if (key.startsWith(`${treeId}:`)) previous.delete(key);
    const sourceDistances = {};
    let intensity = 0;
    let distance = 0;
    for (const [source, bucket] of total.bySource) {
      const sourceDistance = round(bucket.distance, 4);
      const cap = clamp01(finite(sourceCaps[source], source === 'user' ? 0.55 : 0.45));
      sourceDistances[source] = sourceDistance;
      distance += bucket.distance;
      intensity += Math.min(cap, bucket.distance / reference * cap);
    }
    return Object.freeze({
      intensity: total.samples > 0 ? round(clamp01(intensity), 4) : null,
      distance: round(distance, 4),
      samples: total.samples,
      sources: Object.freeze([...total.bySource.keys()].sort()),
      sourceDistances: Object.freeze(sourceDistances),
    });
  }

  return Object.freeze({ feed, finishDay });
}

// Texture/Jungle 没有神经后端行；Amen 切片、音高枝与句尾编辑构成本地音色
// 空间。只对该本地引擎使用日结代理，不替代神经声部的 sent 观测。
export function localTextureExplorationFromDay(observed = {}) {
  const onset = clamp01(finite(observed.sequenceOnsetCount) / 12);
  const change = clamp01(finite(observed.branchChangesPerLoop) / 8);
  const variation = 1 - clamp01(observed.intervalRegularity);
  if (onset <= 0 && change <= 0) return 0;
  return round(clamp01(0.12 * onset + 0.12 * change + 0.08 * variation), 4);
}

function resource(value, terms = []) {
  const rawDelta = terms.reduce((sum, term) => sum + finite(term.delta), 0);
  const next = clamp(value + rawDelta, SURVIVAL_RESERVE, 100);
  const appliedDelta = next - value;
  const adjusted = [...terms];
  const protection = appliedDelta - rawDelta;
  if (Math.abs(protection) > 0.005) adjusted.push({
    key: protection > 0 ? 'safetyReserve' : 'capacityLimit',
    label: protection > 0 ? '安全储备保护' : '资源容量保护',
    delta: protection,
  });
  return Object.freeze({
    value: round(next),
    delta: round(appliedDelta),
    terms: Object.freeze(adjusted.map((term) => Object.freeze({
      key: term.key,
      label: term.label,
      delta: round(term.delta),
    }))),
  });
}

function previousValue(previous, treeId, key, initialValue) {
  return clamp(finite(previous?.trees?.[treeId]?.[key]?.value, initialValue), SURVIVAL_RESERVE, 100);
}

function frozenResource(value) {
  return resource(value, [{ key: 'userControl', label: '用户接管·本日冻结', delta: 0 }]);
}

/**
 * 结算顺序固定：树枝活动 → 音色探索 → 夜间进食。转换支出取实际可用值，
 * 所以任何一步都不会穿透安全储备；terms 与最终 delta 始终可以逐项对账。
 */
export function settleSurvivalDay({
  day,
  trees = {},
  previous = null,
  controls = {},
  initialValue = DEFAULT_VALUE,
} = {}) {
  const settledTrees = {};
  for (const [treeId, observed = {}] of Object.entries(trees)) {
    const before = Object.fromEntries(SURVIVAL_RESOURCE_KEYS.map((key) => [
      key, previousValue(previous, treeId, key, initialValue),
    ]));
    if (controls[treeId] === 'USER') {
      settledTrees[treeId] = Object.freeze({
        health: frozenResource(before.health),
        stamina: frozenResource(before.stamina),
        food: frozenResource(before.food),
        flags: Object.freeze(['user-frozen']),
        transactions: Object.freeze([]),
      });
      continue;
    }

    const onsetLoad = clamp01(finite(observed.sequenceOnsetCount) / 12);
    const regularity = clamp01(observed.intervalRegularity);
    const harmony = observed.harmonyScore == null ? 0.5 : clamp01(observed.harmonyScore);
    const crossVoice = observed.crossVoice == null ? 0.5 : clamp01(observed.crossVoice);
    const exploration = observed.latentExploration == null
      ? null : clamp01(observed.latentExploration);
    const actionId = ['rest', 'perch', 'explore', 'balance'].includes(observed.survivalActionId)
      ? observed.survivalActionId : 'balance';
    const actionBudget = {
      rest: { branch: 0.25, explore: 0.2 },
      perch: { branch: 1, explore: 0.35 },
      explore: { branch: 0.45, explore: 1 },
      balance: { branch: 0.7, explore: 0.65 },
    }[actionId];

    // 树枝活动以生命为预算，规律与和谐只提高换回体力的效率。
    const desiredBranchSpend = onsetLoad > 0 ? (1 + 3 * onsetLoad) * actionBudget.branch : 0;
    const branchEfficiency = 0.9 + 0.2 * regularity + 0.1 * harmony;
    const branchSpend = Math.min(
      desiredBranchSpend,
      Math.max(0, before.health - SURVIVAL_RESERVE),
      Math.max(0, 100 - before.stamina) / branchEfficiency,
    );
    const staminaGain = branchSpend * branchEfficiency;

    // 探索按观测到的真实路径结算。来源在 observer 内分别限幅，一次用户横拖
    // 最多贡献 0.55，不会独自吃掉全天预算。
    const desiredExploreSpend = exploration == null ? 0 : 7 * exploration * actionBudget.explore;
    const foodEfficiency = 1.5 + 0.35 * harmony + 0.2 * crossVoice;
    const exploreSpend = Math.min(
      desiredExploreSpend,
      Math.max(0, before.stamina + staminaGain - SURVIVAL_RESERVE),
      Math.max(0, 100 - before.food) / foodEfficiency,
    );
    const foodGain = exploreSpend * foodEfficiency;

    // 夜间固定进食；食物不足时保留安全储备，恢复量随实际进食量下降。
    const healthAfterBranch = before.health - branchSpend;
    const mealSpend = Math.min(
      DAILY_MEAL,
      Math.max(0, before.food + foodGain - SURVIVAL_RESERVE),
      Math.max(0, 100 - healthAfterBranch) / 0.7,
    );
    const healthGain = mealSpend * 0.7;

    const health = resource(before.health, [
      { key: 'branchActivity', label: '树枝活动', delta: -branchSpend },
      { key: 'nightMeal', label: '夜间进食', delta: healthGain },
    ]);
    const stamina = resource(before.stamina, [
      { key: 'branchRecovery', label: '栖枝恢复', delta: staminaGain },
      { key: 'latentExploration', label: '音色探索', delta: -exploreSpend },
    ]);
    const food = resource(before.food, [
      { key: 'explorationFood', label: '探索所得', delta: foodGain },
      { key: 'nightMeal', label: '夜间进食', delta: -mealSpend },
    ]);
    const flags = [];
    if (health.value <= 20) flags.push('low-health');
    if (stamina.value <= 20) flags.push('low-stamina');
    if (food.value <= 20) flags.push('low-food');
    if (observed.clipWarn) flags.push('clipping-observed');
    if (exploration == null) flags.push('exploration-unobserved');

    settledTrees[treeId] = Object.freeze({
      health,
      stamina,
      food,
      flags: Object.freeze(flags),
      transactions: Object.freeze([
        Object.freeze({ id: 'branch', actionId, spent: round(branchSpend), gained: round(staminaGain), efficiency: round(branchEfficiency, 3) }),
        Object.freeze({ id: 'explore', actionId, spent: round(exploreSpend), gained: round(foodGain), efficiency: round(foodEfficiency, 3) }),
        Object.freeze({ id: 'meal', spent: round(mealSpend), gained: round(healthGain), efficiency: 0.7 }),
      ]),
    });
  }
  return Object.freeze({
    day: Math.max(0, Math.trunc(finite(day))),
    source: 'survival-loop',
    trees: Object.freeze(settledTrees),
  });
}

export function createSurvivalShadow({ treeIds = [], initialValue = DEFAULT_VALUE } = {}) {
  let current = Object.freeze({
    day: 0,
    source: 'survival-loop',
    trees: Object.freeze(Object.fromEntries(treeIds.map((treeId) => [treeId, Object.freeze({
      health: resource(initialValue),
      stamina: resource(initialValue),
      food: resource(initialValue),
      flags: Object.freeze([]),
      transactions: Object.freeze([]),
    })]))),
  });
  const history = [];
  return Object.freeze({
    settle(input = {}) {
      current = settleSurvivalDay({ ...input, previous: current, initialValue });
      history.push(current);
      return current;
    },
    snapshot() { return current; },
    history() { return Object.freeze([...history]); },
  });
}
