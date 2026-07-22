// 三维生存经济 Phase 0：只读 shadow ledger。
//
// 输入只来自已经存在的日结事实；输出不写回 world / agent。scoreDay 继续担当
// 确定性安全层，这里只增加跨日存量与面向用户的三项简明叙事。

const RESOURCE_KEYS = Object.freeze(['stamina', 'health', 'catch']);
const DEFAULT_VALUE = 60;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const clamp01 = (value) => clamp(finite(value), 0, 1);
const round = (value, digits = 2) => Number(finite(value).toFixed(digits));

function resource(value, delta, terms) {
  return Object.freeze({
    value: round(clamp(value + delta, 0, 100)),
    delta: round(delta),
    terms: Object.freeze(terms.map((term) => Object.freeze({
      key: term.key,
      label: term.label,
      delta: round(term.delta),
    }))),
  });
}

function sumTerms(terms) {
  return terms.reduce((sum, term) => sum + term.delta, 0);
}

function previousValue(previous, treeId, key, initialValue) {
  return clamp(finite(previous?.trees?.[treeId]?.[key]?.value, initialValue), 0, 100);
}

function frozenResource(value) {
  return resource(value, 0, [{ key: 'userControl', label: '用户接管·本日冻结', delta: 0 }]);
}

/**
 * 结算一天的 shadow 资源。所有 delta 都是有界、确定性的事实映射；Master 的
 * “心情”只允许在后续阶段选择合法菜单，不能直接发明数值或越过安全护栏。
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
    const before = Object.fromEntries(RESOURCE_KEYS.map((key) => [
      key, previousValue(previous, treeId, key, initialValue),
    ]));
    if (controls[treeId] === 'USER') {
      settledTrees[treeId] = Object.freeze({
        stamina: frozenResource(before.stamina),
        health: frozenResource(before.health),
        catch: frozenResource(before.catch),
        flags: Object.freeze(['user-frozen']),
      });
      continue;
    }

    // 起音负载只表达“一天用了多少 Sequence”，规律度再判断是否形成有效觅食。
    const onsetLoad = clamp01(finite(observed.sequenceOnsetCount) / 12);
    const regularity = clamp01(observed.intervalRegularity);
    const harmony = observed.harmonyScore == null ? 0.5 : clamp01(observed.harmonyScore);
    const crossVoice = observed.crossVoice == null ? 0.5 : clamp01(observed.crossVoice);
    // 潜空间探索尚未接线时为 null 豁免，绝不把“无数据”伪装成“未探索”。
    const exploration = observed.latentExploration == null
      ? null : clamp01(observed.latentExploration);

    const staminaTerms = [
      {
        key: 'dailyRecovery', label: '休养恢复',
        delta: 1 + 0.08 * (60 - before.stamina),
      },
      { key: 'dailyCost', label: '日常消耗', delta: -1 },
    ];
    if (exploration != null) {
      staminaTerms.push({ key: 'latentExploration', label: '音色探索', delta: -6 * exploration });
    }

    const healthTerms = [
      { key: 'sequenceCost', label: '音序消耗', delta: -4 * onsetLoad },
      { key: 'harmony', label: '整体和谐', delta: 4 * (harmony - 0.5) },
      { key: 'clipSafety', label: observed.clipWarn ? '削波损伤' : '安全电平', delta: observed.clipWarn ? -5 : 1 },
      { key: 'dailyCare', label: '日常养护', delta: -0.5 + 0.06 * (60 - before.health) },
    ];
    if (exploration != null) {
      healthTerms.push({ key: 'latentVitality', label: '探索活力', delta: 3 * exploration });
    }

    const catchTerms = [
      { key: 'structuredSequence', label: '结构化觅食', delta: 7 * onsetLoad * regularity },
      { key: 'ensemble', label: '声部协作', delta: 3 * (crossVoice - 0.5) },
      { key: 'harmony', label: '整体和谐', delta: 2 * (harmony - 0.5) },
      { key: 'dailyUse', label: '日常消耗', delta: -0.06 * before.catch },
    ];

    const stamina = resource(before.stamina, clamp(sumTerms(staminaTerms), -8, 8), staminaTerms);
    const health = resource(before.health, clamp(sumTerms(healthTerms), -8, 8), healthTerms);
    const catchResource = resource(before.catch, clamp(sumTerms(catchTerms), -8, 8), catchTerms);
    const flags = [];
    if (stamina.value <= 20) flags.push('low-stamina');
    if (health.value <= 20) flags.push('low-health');
    if (catchResource.value <= 20) flags.push('low-catch');
    if (observed.clipWarn) flags.push('clipping');
    if (exploration == null) flags.push('exploration-unobserved');

    settledTrees[treeId] = Object.freeze({
      stamina,
      health,
      catch: catchResource,
      flags: Object.freeze(flags),
    });
  }
  return Object.freeze({
    day: Math.max(0, Math.trunc(finite(day))),
    source: 'deterministic-shadow',
    trees: Object.freeze(settledTrees),
  });
}

export function createSurvivalShadow({ treeIds = [], initialValue = DEFAULT_VALUE } = {}) {
  let current = Object.freeze({
    day: 0,
    source: 'deterministic-shadow',
    trees: Object.freeze(Object.fromEntries(treeIds.map((treeId) => [treeId, Object.freeze({
      stamina: resource(initialValue, 0, []),
      health: resource(initialValue, 0, []),
      catch: resource(initialValue, 0, []),
      flags: Object.freeze([]),
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
