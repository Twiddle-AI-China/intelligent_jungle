// mvp/src/agent.js —— 日界变奏 agent + 评估流水线 + master 决策（Phase 1.8/T6）。
// 时序（§3.5.1.4）：第 N 天全天，agent 复盘第 N−1 天的完整数据 → 当天内产出计划
// → 第 N+1 天黎明随换和弦一起生效。LLM 真实接线经 mvp/src/llm/integration.js 的
// createAgentPipeline（白天 dayReview、黎明 dawnPlan 领取、未就绪规则兜底）。
// 和声（docs/harmony-season-redesign.md）：季 = 单和弦骨架，昼夜 = 色彩档；
// conductor 每黎明构建 harmonicFrame{season, seasonDay, seasonLength, skeleton,
// color, tension}（上游 dawnPlan 提供 color/tension/seasonLength 则用之，否则规则兜底），
// 只在换季日做家枝大迁移；和谐分 H 只观测（骨架 1.0/色彩 0.7/框架外 0），不进计分。
//
// evaluateDay 是纯函数规则层；attachPipelineConductor 负责接线（DOM-free，可测）。
// 只引用生态词汇——骨架/色彩与家枝迁移由 harmony.js 提供，conductor 只做编排。

import { CONFIG } from './config.js';
import { skeletonForSeason, colorOptions, chordFromFrame, migrateAssignments } from './harmony.js';
import { decideMaster } from './master/policy.js';
import { isRunnerBranchId, runnerMetaFromBranchId, verticalBranchCount } from './mapping.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const TIER_ORDER = ['sparse', 'normal', 'full'];
// TODO-config：activeBars 的规则侧调整尚无独立参数；先用最小一档 1 小节，
// 并保留至少 1 小节可闻窗口。全天小节数优先由 rulePlan 注入 tempo.barsPerDay。
const ACTIVE_BARS_STEP = 1;
const MIN_AUDIBLE_ACTIVE_BARS = 1;
function tierStep(tier, dir) {
  const i = TIER_ORDER.indexOf(tier);
  const j = clamp(i + dir, 0, TIER_ORDER.length - 1);
  return TIER_ORDER[j];
}

export function meanTreePatternSimilarity(previous = {}, current = {}) {
  const treeIds = Object.keys(current).filter((treeId) => Array.isArray(previous[treeId]));
  if (!treeIds.length) return 0;
  const scores = treeIds.map((treeId) => {
    const before = previous[treeId];
    const after = current[treeId];
    if (!Array.isArray(after) || !before.length || before.length !== after.length) return 0;
    let same = 0;
    for (let i = 0; i < before.length; i += 1) if (before[i] === after[i]) same += 1;
    return same / before.length;
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export function filterMutationBounds(mutations, branchCount) {
  const accepted = [];
  const dropped = [];
  for (const mutation of Array.isArray(mutations) ? mutations : []) {
    const from = Number(mutation?.from);
    const to = Number(mutation?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
      || from >= branchCount || to >= branchCount || from === to) {
      dropped.push({ ...mutation, reason: 'branch-out-of-range' });
    } else {
      accepted.push(mutation);
    }
  }
  return { accepted, dropped };
}

// 和谐分 H'（只观测不进 economy）：先按骨架/色彩/框架外权重求原始 H，再把正常
// 可达值域 [colorWeight, 1] 重定标到 [0,1]。无发音返回 null（观测缺失，非 0 分）。
export function harmonyScoreFromCounts(
  counts,
  weights = CONFIG.harmony.harmonyWeights,
  rescaleFloor = CONFIG.harmony.harmonyRescaleFloor ?? weights.color,
) {
  const skeleton = counts?.skeleton ?? 0;
  const color = counts?.color ?? 0;
  const outside = counts?.outside ?? 0;
  const total = skeleton + color + outside;
  if (!total) return null;
  const raw = (skeleton * weights.skeleton + color * weights.color + outside * weights.outside) / total;
  const floor = clamp(Number(rescaleFloor), 0, 1);
  if (floor >= 1) return raw >= 1 ? 1 : 0;
  return clamp((raw - floor) / (1 - floor), 0, 1);
}

// pad 的音级多样性只在 conductor 翻译层计算：world 仍只接收枝权重。
// 权重反比于当前已占音级数，且保留正下限，因此是软偏好而非强制配音。
export function padDiversityBranchWeights(notes = [], occupiedBranches = [], baseWeights = []) {
  const branchCount = Math.min(notes.length, baseWeights.length || notes.length);
  if (!branchCount) return [...baseWeights];
  const pitchClasses = notes.slice(0, branchCount).map((note) => {
    const n = Number(note);
    return Number.isFinite(n) ? ((Math.round(n) % 12) + 12) % 12 : null;
  });
  const counts = new Map();
  for (const branch of occupiedBranches) {
    const pc = pitchClasses[Number(branch)];
    if (pc != null) counts.set(pc, (counts.get(pc) ?? 0) + 1);
  }
  if (!counts.size) return Array.from({ length: branchCount }, (_, i) => clamp(Number(baseWeights[i] ?? 1), 0, 1));
  const scarcity = pitchClasses.map((pc) => (pc == null ? 1 : 1 / (1 + (counts.get(pc) ?? 0))));
  const maxScarcity = Math.max(...scarcity, 1e-9);
  return scarcity.map((value, i) => {
    const base = clamp(Number(baseWeights[i] ?? 1), 0, 1);
    const diversity = value / maxScarcity;
    // 多样性为主、张力枝偏好为辅；最低 0.25 保证任何枝仍可能被选中。
    return clamp(0.25 + 0.75 * (0.3 * base + 0.7 * diversity), 0, 1);
  });
}

// C4：鹈鹕根音/西端软枝偏好——world 只收 0..1；西端 nodeIndex=0 权最高，东端渐低。
// 非强制：最低权仍 >0，邻节点迈步与落枝仍可到东端。
export function bassRootBranchWeights(branchCount, cfg = CONFIG, baseWeights = []) {
  const n = Math.max(0, Math.floor(Number(branchCount) || 0));
  if (!n) return [];
  const vert = verticalBranchCount(cfg);
  return Array.from({ length: n }, (_, branchId) => {
    const base = clamp(Number(baseWeights[branchId] ?? 1), 0, 1);
    const meta = runnerMetaFromBranchId(branchId, cfg);
    if (meta) {
      const denom = Math.max(1, meta.nodeCount - 1);
      const westBias = 1 - 0.65 * (meta.nodeIndex / denom); // 西端 1 → 东端 0.35
      return clamp(0.22 + 0.78 * (0.3 * base + 0.7 * westBias), 0, 1);
    }
    // 纵向槽：若未在 allowed 内几乎不会被抽到；仍给弱权以免数组空洞。
    if (branchId < vert) return clamp(0.15 * base, 0, 1);
    return base;
  });
}

export function ensurePatternMutation(mutations, birds, branchCount, rng = Math.random) {
  const current = new Map((birds ?? []).map((bird) => [bird.id, bird.homeBranch]));
  const picked = (mutations ?? []).map((mutation) => ({ ...mutation }));
  if (!current.size || branchCount < 2) return picked;
  const beforeSet = new Set(current.values());
  const after = new Map(current);
  for (const mutation of picked) if (after.has(mutation.birdId)) after.set(mutation.birdId, mutation.to);
  const afterSet = new Set(after.values());
  const changedSet = beforeSet.size !== afterSet.size
    || [...beforeSet].some((branch) => !afterSet.has(branch));
  if (picked.length && changedSet) return picked;

  const alreadyMoved = new Set(picked.map((mutation) => mutation.birdId));
  const candidates = [...current.entries()].filter(([birdId]) => !alreadyMoved.has(birdId));
  const pool = candidates.length ? candidates : [...current.entries()];
  const [birdId, from] = pool[Math.min(pool.length - 1, Math.floor(clamp(rng(), 0, 0.999999) * pool.length))];
  const targets = Array.from({ length: branchCount }, (_, branch) => branch)
    .filter((branch) => branch !== from)
    .sort((a, b) => {
      const aMissing = beforeSet.has(a) ? 1 : 0;
      const bMissing = beforeSet.has(b) ? 1 : 0;
      return aMissing - bMissing || Math.abs(a - from) - Math.abs(b - from) || a - b;
    });
  const forced = { birdId, from, to: targets[0], forced: true };
  if (picked.length >= 1) picked[picked.length - 1] = forced;
  else picked.push(forced);
  return picked;
}

// 规则层日评估（纯函数）。dayStats：world 黎明事件载荷里的日终统计。
// assignments：[{birdId, homeBranch}]。cfg：{...CONFIG.agent, branchCount, dwellBase, barsPerDay}。
// ecology：economy 日结摘要；消费 deviation.branchChanges / crossVoice + crossVoiceHint。
export function evaluateDay(dayStats, assignments, cfg, rng = Math.random, ecology = null) {
  const reasons = [];
  const mutations = [];
  const loads = [...dayStats.branchLoads];

  // 规则 A 散巢：家枝拥挤（≥crowdedBranchSize）且存在明显更轻的枝 → 搬一只过去。
  const crowdedIdx = loads.findIndex((l) => l >= cfg.crowdedBranchSize);
  if (crowdedIdx >= 0 && mutations.length < cfg.maxMutationsPerDay) {
    let lightest = 0;
    for (let i = 1; i < loads.length; i += 1) if (loads[i] < loads[lightest]) lightest = i;
    if (loads[lightest] + 1 < loads[crowdedIdx]) {
      const bird = assignments.find((a) => a.homeBranch === crowdedIdx
        && !mutations.some((m) => m.birdId === a.birdId));
      if (bird) {
        mutations.push({ birdId: bird.birdId, from: crowdedIdx, to: lightest });
        loads[crowdedIdx] -= 1;
        loads[lightest] += 1;
        reasons.push(`散巢:鸟${bird.birdId} 家枝${crowdedIdx}→${lightest}（枝${crowdedIdx}拥挤）`);
      }
    }
  }

  // 规则 B 漫游变异：无拥挤时也以小概率变一只，保持进化压力（变奏不是重掷骰子）。
  // P2-1：seasonMigrationOnly（bass）不进漫游候选——规则层豁免，不靠运行时拦截。
  if (!cfg.seasonMigrationOnly
    && mutations.length < cfg.maxMutationsPerDay && rng() < cfg.roamMutationChance) {
    const candidates = assignments.filter((a) => !mutations.some((m) => m.birdId === a.birdId));
    if (candidates.length) {
      const bird = candidates[Math.floor(rng() * candidates.length)];
      const others = Array.from({ length: cfg.branchCount }, (_, i) => i).filter((i) => i !== bird.homeBranch);
      const to = others[Math.floor(rng() * others.length)];
      mutations.push({ birdId: bird.birdId, from: bird.homeBranch, to });
      reasons.push(`漫游:鸟${bird.birdId} 家枝${bird.homeBranch}→${to}（注入小变异）`);
    }
  }

  // 规则 C 密度档位：全天太静 → 升档加鸟；换枝太疯 → 降档减鸟。
  let densityTier = dayStats.densityTier;
  if (dayStats.silentRatio > cfg.silentRaiseThreshold) {
    const next = tierStep(densityTier, +1);
    if (next !== densityTier) {
      reasons.push(`密度:${densityTier}→${next}（全天沉默占比 ${dayStats.silentRatio.toFixed(2)}）`);
      densityTier = next;
    }
  } else if (dayStats.switchRate > cfg.frenzyLowerThreshold) {
    const next = tierStep(densityTier, -1);
    if (next !== densityTier) {
      reasons.push(`密度:${densityTier}→${next}（日换枝率 ${dayStats.switchRate.toFixed(1)} 过疯）`);
      densityTier = next;
    }
  }

  // 规则 D dwell 基线：当日平均驻留偏离 economy 偏好带 → 明日微调（T40 P1-1）。
  // 判据优先用 cfg.dwellPref（economy.prefs[species].meanDwell）；hi=Infinity 永不报偏长。
  // 双树统计不携带 dwellBaseline：从当日生效的 dwellBeats 反推，缺省 1（防 NaN）。
  let dwellBaseline = Number.isFinite(dayStats.dwellBaseline)
    ? dayStats.dwellBaseline
    : (cfg.dwellBase > 0 && Number.isFinite(dayStats.dwellBeats)
      ? clamp(dayStats.dwellBeats / cfg.dwellBase, cfg.dwellBaselineMin, cfg.dwellBaselineMax)
      : 1);
  const pref = cfg.dwellPref;
  const bandLo = Number.isFinite(pref?.lo) ? pref.lo : cfg.dwellBase * cfg.dwellExpectLowFactor;
  const rawHi = pref?.hi;
  const bandHi = rawHi === Number.POSITIVE_INFINITY
    ? rawHi
    : (Number.isFinite(rawHi) ? rawHi : cfg.dwellBase * cfg.dwellExpectHighFactor);
  // 比较口径统一为拍：与 economy/world 同一份 meanDwellBeats。
  const meanDwellBeats = Number.isFinite(dayStats.meanDwellBeats)
    ? dayStats.meanDwellBeats : dayStats.meanDwell;
  const dwellTooShort = dayStats.dwellSampleCount > 0 && meanDwellBeats < bandLo;
  const dwellTooLong = dayStats.dwellSampleCount > 0
    && Number.isFinite(bandHi) && meanDwellBeats > bandHi;
  if (dwellTooShort) {
    dwellBaseline = clamp(dwellBaseline + cfg.dwellBaselineStep, cfg.dwellBaselineMin, cfg.dwellBaselineMax);
    if (dwellBaseline !== dayStats.dwellBaseline) reasons.push(`驻留:偏短（${meanDwellBeats.toFixed(1)}拍），基线→${dwellBaseline.toFixed(2)}`);
  } else if (dwellTooLong) {
    dwellBaseline = clamp(dwellBaseline - cfg.dwellBaselineStep, cfg.dwellBaselineMin, cfg.dwellBaselineMax);
    if (dwellBaseline !== dayStats.dwellBaseline) reasons.push(`驻留:偏长（${meanDwellBeats.toFixed(1)}拍），基线→${dwellBaseline.toFixed(2)}`);
  }

  // 闭环规则：economy 已完成偏好带比较，规则层只消费方向，避免复制评分公式。
  // 换枝偏低 → 缩短驻留以增加起落机会；若基线已无法再降，则升密度档。
  // 换枝偏高 → 延长驻留，并把次日活跃窗收窄一档。cohortSize 不在此重复处理。
  const branchDeviation = ecology?.deviation?.branchChanges;
  const branchDirection = typeof branchDeviation === 'string'
    ? branchDeviation : branchDeviation?.direction;
  const fullActiveBars = Math.max(MIN_AUDIBLE_ACTIVE_BARS,
    Math.round(Number(cfg.barsPerDay) || 4));
  let activeBars = fullActiveBars;
  if (branchDirection === 'low') {
    const shortened = clamp(
      dwellBaseline - cfg.dwellBaselineStep,
      cfg.dwellBaselineMin,
      cfg.dwellBaselineMax,
    );
    // 若驻留维本身已偏短，不用一升一降互相抵消；改走同一现有执行器的密度升档。
    if (!dwellTooShort && shortened < dwellBaseline && cfg.dwellBase * shortened >= bandLo) {
      dwellBaseline = shortened;
      reasons.push(`换枝偏低→明日缩短驻留（基线 ${dwellBaseline.toFixed(2)}）`);
    } else {
      const next = tierStep(densityTier, +1);
      if (next !== densityTier) {
        reasons.push(`换枝偏低→明日密度 ${densityTier}→${next}`);
        densityTier = next;
      }
    }
  } else if (branchDirection === 'high') {
    // 同理，驻留维已偏长时不抵消它的缩短纠偏；activeBars 收窄已能降低换枝机会。
    const beforeBranchAdjustment = dwellBaseline;
    if (!dwellTooLong) {
      dwellBaseline = clamp(
        dwellBaseline + cfg.dwellBaselineStep,
        cfg.dwellBaselineMin,
        cfg.dwellBaselineMax,
      );
    }
    const silentHigh = dayStats.silentRatio > cfg.silentRaiseThreshold;
    activeBars = silentHigh
      ? fullActiveBars
      : Math.max(MIN_AUDIBLE_ACTIVE_BARS, fullActiveBars - ACTIVE_BARS_STEP);
    const dwellAction = dwellBaseline > beforeBranchAdjustment ? '延长驻留、' : '';
    reasons.push(`换枝偏高→明日${dwellAction}活跃窗 ${fullActiveBars}→${activeBars} 小节`
      + (silentHigh ? '（沉默偏高，保持满窗）' : ''));
  }

  // Track B：跨声部错峰缺口 → 密度/驻留/活跃窗偏置（涌现式，不写死声部角色）。
  // 减弱执行交给 world.setVocalizeBias(0..1 梯度)；这里不改 densityTier，
  // 避免 sparse 粘住后 hold 日无法回满、把合奏长期掐哑。
  const crossDeviation = ecology?.deviation?.crossVoice;
  const crossDirection = typeof crossDeviation === 'string'
    ? crossDeviation : crossDeviation?.direction;
  const crossHint = ecology?.crossVoiceHint;
  if (crossDirection === 'low' && crossHint === 'suppress') {
    if (!dwellTooLong) {
      dwellBaseline = clamp(
        dwellBaseline + cfg.dwellBaselineStep,
        cfg.dwellBaselineMin,
        cfg.dwellBaselineMax,
      );
    }
    if (activeBars > MIN_AUDIBLE_ACTIVE_BARS) {
      activeBars = Math.max(MIN_AUDIBLE_ACTIVE_BARS, activeBars - ACTIVE_BARS_STEP);
    }
    reasons.push(`错峰偏低·抑制→发声梯度减弱、活跃窗→${activeBars}`);
  } else if (crossDirection === 'low' && crossHint === 'encourage') {
    const next = tierStep(densityTier, +1);
    if (next !== densityTier) {
      reasons.push(`错峰偏低·填充→密度 ${densityTier}→${next}`);
      densityTier = next;
    }
    if (!dwellTooShort) {
      const shortened = clamp(
        dwellBaseline - cfg.dwellBaselineStep,
        cfg.dwellBaselineMin,
        cfg.dwellBaselineMax,
      );
      if (shortened < dwellBaseline) {
        dwellBaseline = shortened;
        reasons.push(`错峰偏低·填充→缩短驻留（基线 ${dwellBaseline.toFixed(2)}）`);
      }
    }
    activeBars = fullActiveBars;
  }

  if (!reasons.length) reasons.push('保持：今日 pattern 均衡，明日原样循环');
  return { mutations, densityTier, dwellBaseline, activeBars, reason: reasons.join('；') };
}

// LLM flock 计划 → 内部 plan 形状（契约 {dwellBeats, activeBars, holdLoops, mutations[]}，
// 与 llm/integration.js 的 mapFlockPlan 对齐）。mutations 无 birdId，映射到家枝在该枝的鸟。
export function planFromLlm(llmPlan, assignments, stats, cfg = CONFIG.agent) {
  const decision = llmPlan?.flocks?.[0];
  if (!decision || !Array.isArray(decision.mutations)) return null;
  const mutations = [];
  const droppedMutations = [];
  const branchCount = cfg.branchCount ?? CONFIG.tree.branches.length;
  for (const s of decision.mutations) {
    const bounded = filterMutationBounds([s], branchCount);
    if (bounded.dropped.length) {
      droppedMutations.push(...bounded.dropped);
      continue;
    }
    const bird = assignments.find((a) => a.homeBranch === s.from
      && !mutations.some((m) => m.birdId === a.birdId));
    if (bird) mutations.push({ birdId: bird.birdId, from: s.from, to: s.to });
    else droppedMutations.push({ ...s, reason: 'no-home-assignment' });
    if (mutations.length >= cfg.maxMutationsPerDay) break;
  }
  return {
    mutations,
    droppedMutations,
    densityTier: stats.densityTier,
    dwellBeats: decision.dwellBeats,
    activeBars: decision.activeBars,
    holdLoops: decision.holdLoops,
    reason: `LLM: 驻留${decision.dwellBeats}拍 · 活跃${decision.activeBars}小节 · 保持${decision.holdLoops}循环`,
  };
}

// master 菜单（季=单骨架契约）：每季一条路径 + 当季风盘色彩 id 列表。
// 字段同时保留 progressions/seasonPalettes 兼容形态（llm-master 与 policy.js 均消费）。
// 防音乐泄漏：progressions 兼容位用中性 id（季节名），和弦名/F 系音名不进菜单。
export function masterMenuFromConfig(cfg = CONFIG) {
  const { seasons, bySeason } = cfg.harmony;
  return {
    seasons: [...seasons],
    progressions: seasons.map((s) => [s]), // 兼容字段：中性 id（非和弦名）
    seasonPalettes: Object.fromEntries(seasons.map((s) => [s, bySeason[s].colors.map((c) => c.id)])),
    seasonLengthRange: cfg.llm.seasonLengthRange,
    cooldownDays: cfg.llm.masterCooldownDays,
  };
}

// 评估流水线接线（双树版）。
// pipeline：createAgentPipeline 产物（{dayReview, dawnPlan}），可为 null（纯规则）。
// evaluator：遗留测试钩子（async (stats, ctx) => plan），提供时优先于 pipeline 的 flock 通道。
// 回调：onPlan / onApply / onChord / onMaster（均带决策来源标签）。
// holdLoops（§3.5.3.3）：melody 带内冻结、生态偏离时允许一项小变；期满小变
// （≤holdMutationMax、邻枝优先、禁整句重掷、保证真改枝）。
export function attachPipelineConductor(world, {
  config = CONFIG,
  rng = Math.random,
  evaluator = null,
  pipeline = null,
  onPlan = null,
  onApply = null,
  onChord = null,
  onMaster = null,
  // 生态计分注入口（economy 接线）：(treeId) => {branchChangesPerLoop, meanDwellBeats,
  // clusterSize, score, deviation} | null。缺省不注入，LLM prompt 侧按可选字段处理。
  ecologyProvider = null,
} = {}) {
  const masterMenu = masterMenuFromConfig(config);
  let pipelineRef = pipeline; // 可在运行中换入/换出（API key 输入后重建）
  // 季游标（季=单和弦骨架）：seasonDay 0-based；seasonLength 为当季总长。
  // master 在季末日的 nextSeason/seasonLength 存为换季预告，次日黎明生效。
  // daysSinceChange 初值=2：避开「开局伪冷却」——仅真实换季才归零进入 SEASON_COOLDOWN_DAYS。
  // currentColorId/daysInColor：决策应用后回填，供次日 master 三观（腻值/换档基准）。
  const SCORE_HISTORY_DAYS = 3; // policy trailingLow 连续低分至少要 2 天历史
  const cursor = {
    seasonIdx: 0,
    seasonDay: 0,
    seasonLength: config.harmony.defaultSeasonLength,
    daysSinceChange: 2,
    currentColorId: null,
    daysInColor: 0,
  };
  // 每树 score 短历史（滚动 2–3 天）：policy 读数组尾部 streak，标量永远 streak≤1。
  const treeScoreHistory = Object.fromEntries(config.trees.map((t) => [t.id, []]));
  const harmonyScoreHistory = Object.fromEntries(config.trees.map((t) => [t.id, []]));
  let pendingNext = null; // { seasonIdx, seasonLength }：换季预告
  let currentFrame = null;
  let currentChord = null;
  let pendingPlan = null;   // evaluator 钩子路径的待生效计划（按树：{treeId: plan}）
  let pendingSource = null;
  let pendingReviewedDay = null;
  const patternHistory = []; // 每日家枝 pattern（算相似度给 master 观测）
  // 乐句保持期状态（按树）：{counter, loops}；counter 从 0 计，首个期满在默认 H 后
  const holdState = Object.fromEntries(config.trees.map((t) => [t.id, {
    counter: 0,
    loops: config.agent.defaultHoldLoops,
  }]));

  // ---- 和谐分 H（只观测不进分）：逐树逐日统计「发音落枝」的框架归属 ----
  // 按发音秒加权（持续在鸣也计入，否则长驻物种天天无观测）：骨架枝 1.0 / 色彩枝 0.7 /
  // 框架外 0；原始 H 再以 harmonyRescaleFloor 满量程化为 H'，全天无发音 → null。
  const hCounts = Object.fromEntries(config.trees.map((t) => [t.id, { skeleton: 0, color: 0, outside: 0 }]));
  const hPerchStart = new Map(); // birdId -> { treeId, key, start }（在鸣中的鸟）
  const classOfBranch = (branchId) => {
    // C3：runner 节点映射和弦音 → 计为骨架（非框架外）；world 仍只给 id。
    if (isRunnerBranchId(branchId, config)) return 'skeleton';
    if (!Number.isInteger(branchId) || branchId < 0 || branchId >= config.tree.branches.length) return 'outside';
    return branchId < config.harmony.skeletonBranches ? 'skeleton' : 'color';
  };
  world.on('perch', (event) => {
    if (!hCounts[event.treeId]) return;
    hPerchStart.set(event.birdId, {
      treeId: event.treeId, key: classOfBranch(event.branchId), start: world.getSnapshot().simTime,
    });
  });
  world.on('unperch', (event) => {
    const rec = hPerchStart.get(event.birdId);
    if (!rec) return;
    hPerchStart.delete(event.birdId);
    const seconds = Number.isFinite(event.dwellTime)
      ? event.dwellTime : Math.max(0, world.getSnapshot().simTime - rec.start);
    hCounts[rec.treeId][rec.key] += Math.max(0, seconds);
  });
  // 读取时把在鸣鸟的已鸣时长临时并入（不改计数器；黎明结算时才真正入账）
  function harmonyScores() {
    const now = world.getSnapshot().simTime;
    const ongoing = {};
    for (const rec of hPerchStart.values()) {
      ongoing[rec.treeId] ??= { skeleton: 0, color: 0, outside: 0 };
      ongoing[rec.treeId][rec.key] += Math.max(0, now - rec.start);
    }
    const w = config.harmony.harmonyWeights;
    const floor = config.harmony.harmonyRescaleFloor ?? w.color;
    return Object.fromEntries(Object.entries(hCounts).map(([treeId, c]) => {
      const merged = {
        skeleton: c.skeleton + (ongoing[treeId]?.skeleton ?? 0),
        color: c.color + (ongoing[treeId]?.color ?? 0),
        outside: c.outside + (ongoing[treeId]?.outside ?? 0),
      };
      return [treeId, {
        harmonyScore: harmonyScoreFromCounts(merged, w, floor),
        perchSeconds: merged.skeleton + merged.color + merged.outside,
        skeletonSeconds: merged.skeleton,
        colorSeconds: merged.color,
        outsideSeconds: merged.outside,
      }];
    }));
  }
  // 黎明入账（本钩子内 flockInput/masterInput 读取之前调用）：在鸣时长进账并跨天重计。
  // ecology 通道的钩子注册更早、在本钩子之前跑——它读到的是 harmonyScores() 的
  // 惰性并入视图（已完成 + 在鸣），总数与本函数入账后的结果一致。
  function settleHarmonyCounts() {
    const now = world.getSnapshot().simTime;
    for (const rec of hPerchStart.values()) {
      hCounts[rec.treeId][rec.key] += Math.max(0, now - rec.start);
      rec.start = now;
    }
  }
  // 日界清零（dayReview 发出之后）：已完成部分归零，在鸣部分已重计起自然滚入下一天
  function resetHarmonyCounts() {
    for (const c of Object.values(hCounts)) { c.skeleton = 0; c.color = 0; c.outside = 0; }
  }

  // 今日 harmonicFrame（契约 docs/harmony-season-redesign.md §3，字段名不改）：
  // color/tension 上游（master 决策）给了合法值就用，否则规则兜底（色彩档轮转、
  // 张力按季节进度 tensionBase→tensionPeak 爬升）。
  function buildFrame(masterDecision) {
    const season = config.harmony.seasons[cursor.seasonIdx];
    const colors = colorOptions(season, config.harmony);
    const color = colors.find((c) => c.id === masterDecision?.colorId)
      ?? colors[cursor.seasonDay % Math.max(1, colors.length)];
    const span = Math.max(1, cursor.seasonLength - 1);
    const tension = Number.isFinite(Number(masterDecision?.tension))
      ? clamp(Number(masterDecision.tension), 0, 1)
      : config.harmony.tensionBase
        + (config.harmony.tensionPeak - config.harmony.tensionBase) * (cursor.seasonDay / span);
    return {
      season,
      seasonDay: cursor.seasonDay,
      seasonLength: cursor.seasonLength,
      skeleton: skeletonForSeason(season, config.harmony),
      color,
      tension,
    };
  }
  // 张力→枝偏好接线（P0-B）：骨架/色彩语义只在 conductor 侧换算，world 只见 0..1 权重。
  function pushBranchPreferences() {
    const bias = config.harmony.tensionBranchBias;
    if (!bias) return;
    const k = config.harmony.skeletonBranches;
    const colorW = bias.colorWeightAt0
      + (bias.colorWeightAt1 - bias.colorWeightAt0) * clamp(currentFrame.tension, 0, 1);
    const weights = config.tree.branches.map((_, i) => (i < k ? bias.skeletonWeight : colorW));
    const snap = world.getSnapshot();
    for (const t of config.trees) {
      let treeWeights = weights;
      const tree = snap.trees.find((entry) => entry.id === t.id);
      const slotCount = tree?.branches?.length ?? weights.length;
      if (t.species === 'pad') {
        const perched = tree?.birds
          .filter((bird) => bird.state === 'perched' && Number.isInteger(bird.branchId))
          .map((bird) => bird.branchId) ?? [];
        const occupied = perched.length ? perched : (tree?.birds.map((bird) => bird.homeBranch) ?? []);
        treeWeights = padDiversityBranchWeights(currentChord.notes, occupied, weights);
      } else if (t.species === 'bass') {
        // C4：根音/西端软偏好；权重长度对齐该树 branch 槽（含 runner）。
        const padded = Array.from({ length: slotCount }, (_, i) => weights[i] ?? weights[weights.length - 1] ?? 1);
        treeWeights = bassRootBranchWeights(slotCount, config, padded);
      }
      world.setBranchPreference?.(t.id, treeWeights);
    }
  }

  // Track B：跨声部错峰缺口 → 发声偏置（world 只收 0..1，不懂声部语义）。
  function pushVocalizeBiases() {
    if (typeof world.setVocalizeBias !== 'function') return;
    const cv = config.economy?.crossVoice ?? {};
    for (const t of config.trees) {
      const eco = ecologyFor(t.id);
      const hint = eco?.crossVoiceHint;
      let bias = Number(cv.holdBias ?? 1);
      if (hint === 'suppress') bias = Number(cv.suppressBias ?? 0);
      else if (hint === 'encourage') bias = Number(cv.encourageBias ?? 1);
      world.setVocalizeBias(t.id, bias);
    }
  }

  currentFrame = buildFrame(null);
  currentChord = chordFromFrame(currentFrame, config.harmony);
  cursor.currentColorId = currentFrame.color.id;
  cursor.daysInColor = 1;
  pushBranchPreferences();

  // 日终分数入账：在 masterInput 之前调用，保证 observations 含「含今日」的短历史数组。
  function pushScoreHistories() {
    const snap = world.getSnapshot();
    const scores = harmonyScores();
    for (const t of snap.trees) {
      const eco = Number(ecologyFor(t.id)?.score);
      const treeScore = Number.isFinite(eco) ? eco : t.meanEnergy;
      const treeHist = treeScoreHistory[t.id];
      treeHist.push(treeScore);
      if (treeHist.length > SCORE_HISTORY_DAYS) treeHist.shift();
      const hHist = harmonyScoreHistory[t.id];
      hHist.push(scores[t.id].harmonyScore);
      if (hHist.length > SCORE_HISTORY_DAYS) hHist.shift();
    }
  }

  // 规则层计划（按树）：契约 {dwellBeats, activeBars, holdLoops, mutations[], densityTier, reason}
  const rulePlan = (treeSnap, treeStats) => {
    const sp = config.species[treeSnap.species];
    const dwellPref = config.economy?.prefs?.[treeSnap.species]?.meanDwell;
    const ecology = ecologyFor(treeSnap.id);
    const base = evaluateDay(treeStats,
      treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch })),
      {
        ...config.agent,
        branchCount: config.tree.branches.length,
        dwellBase: sp.dwellBeats,
        dwellPref,
        barsPerDay: config.tempo.barsPerDay,
        seasonMigrationOnly: !!sp.seasonMigrationOnly,
        crossVoiceSevereConflict: config.economy?.crossVoice?.severeConflictRatio,
      },
      rng,
      ecology);
    const [holdMin, holdMax] = config.agent.holdLoopsRange;
    const holdLoops = Math.round(holdMin + rng() * (holdMax - holdMin)); // agent 范围内自选
    // P1-1：计划 dwell 不得压出偏好带下限（bass/pad lo 有限、hi=∞ → clamp 到 [lo, ∞)）
    let dwellBeats = sp.dwellBeats * base.dwellBaseline;
    if (Number.isFinite(dwellPref?.lo)) dwellBeats = Math.max(dwellBeats, dwellPref.lo);
    return {
      mutations: base.mutations,
      densityTier: base.densityTier,
      dwellBeats,
      activeBars: base.activeBars,
      holdLoops,
      reason: base.reason,
    };
  };

  function patternOf(snapshot) {
    return Object.fromEntries(snapshot.trees.map((tree) => [
      tree.id,
      tree.birds.map((bird) => bird.homeBranch),
    ]));
  }
  function ecologyFor(treeId) {
    try { return ecologyProvider?.(treeId) ?? null; } catch { return null; }
  }

  function masterInput(stats) {
    const snap = world.getSnapshot();
    const prev = patternHistory[patternHistory.length - 2];
    const now = patternHistory[patternHistory.length - 1];
    return {
      menu: masterMenu,
      state: {
        currentSeason: config.harmony.seasons[cursor.seasonIdx],
        seasonDay: cursor.seasonDay,
        seasonLength: cursor.seasonLength,
        daysInSeason: cursor.seasonDay, // 兼容位（旧字段名）
        daysSinceChange: cursor.daysSinceChange,
        // 三观契约（policy.js trailingLow / daysInColor / currentColorId）
        currentColorId: cursor.currentColorId,
        daysInColor: cursor.daysInColor,
      },
      observations: {
        // 短历史数组（非当日标量）：连续低分 streak 才能 ≥ LOW_STREAK_DAYS
        treeScores: snap.trees.map((t) => [...treeScoreHistory[t.id]]),
        harmonyScores: snap.trees.map((t) => [...harmonyScoreHistory[t.id]]),
        patternSimilarity: meanTreePatternSimilarity(prev, now),
      },
    };
  }

  // master 决策落入 frame 后回填色彩状态，供次日 observations/state 使用。
  function commitColorState(colorId) {
    if (typeof colorId !== 'string' || !colorId) return;
    if (colorId === cursor.currentColorId) {
      cursor.daysInColor += 1;
    } else {
      cursor.currentColorId = colorId;
      cursor.daysInColor = 1;
    }
  }

  // harmonicFrame 的生态投影（防音乐泄漏）：枝 id 集合 + 张力 + 色彩档 id，
  // 不带 skeleton/color 的 MIDI 音高——音高只留在 conductor→chordFromFrame→mapping/audio 链。
  function frameProjection() {
    const k = config.harmony.skeletonBranches;
    const branchCount = config.tree.branches.length;
    return {
      tension: currentFrame.tension,
      skeletonBranchIds: Array.from({ length: k }, (_, i) => i),
      colorBranchIds: Array.from({ length: branchCount - k }, (_, i) => k + i),
      colorId: currentFrame.color.id,
    };
  }

  function flockInput(stats) {
    const snap = world.getSnapshot();
    const scores = harmonyScores();
    // 生态投影四字段平铺根级（勿嵌 harmonicFrame）：client.normalizeEcologySnapshot
    // 白名单只读根级/flock 级 tension|skeletonBranchIds|colorBranchIds|colorId。
    return {
      day: stats.day,
      dayPhase: 'dawn',
      season: currentChord.season,
      ...frameProjection(),
      flocks: snap.trees.map((t) => {
        const ecology = ecologyFor(t.id);
        return {
          species: t.species,
          energy: t.meanEnergy,
          perchFlyRatio: t.birds.length ? t.perchedTotal / t.birds.length : 0,
          // 每只鸟当前家枝：mutations.from 只能取自该列表，否则 planFromLlm 整批丢弃。
          homeBranches: t.birds.map((b) => b.homeBranch),
          treeCondition: { health: t.meanEnergy },
          harmonyScore: scores[t.id].harmonyScore, // 和谐分观测（display key 契约）
          dailyStats: {
            branchLoads: stats.trees[t.id].branchLoads,
            meanDwell: stats.trees[t.id].meanDwell,
            meanDwellBeats: stats.trees[t.id].meanDwellBeats,
            switches: stats.trees[t.id].switches,
            silentRatio: stats.trees[t.id].silentRatio,
            densityTier: stats.trees[t.id].densityTier,
          },
          ...(ecology ? { ecology } : {}),
        };
      }),
    };
  }

  // evaluator 钩子路径：第 N 天全天复盘第 N−1 天 → 计划第 N+1 天（async）
  async function runEvaluation(stats) {
    let plans = null;
    let source = null;
    if (evaluator) {
      try {
        plans = await evaluator(stats, { season: currentFrame.season, colorId: currentFrame.color.id });
        if (plans) source = 'LLM';
      } catch { /* 掉线回落规则层 */ }
    }
    if (!plans) {
      const snap = world.getSnapshot();
      plans = Object.fromEntries(snap.trees.map((t) => [t.id, rulePlan(t, stats.trees[t.id])]));
      source = '规则层';
    }
    pendingPlan = plans;
    pendingSource = source;
    pendingReviewedDay = stats.day;
    onPlan?.({ plans, source, reviewedDay: stats.day, targetDay: stats.day + 2 });
  }

  // melody 保持期只在生态带内冻结家枝；偏离时允许一项小变自适应。
  // dwell/active/density 始终可随日评估更新。
  function applyHoldLoops(treeId, plan) {
    const tree = world.getSnapshot().trees.find((t) => t.id === treeId);
    const sp = tree?.species;
    if (config.species[sp]?.seasonMigrationOnly) {
      return { plan: { ...plan, mutations: [] }, held: true, seasonOnly: true };
    }
    if (sp !== 'melody') return { plan, held: false };
    const hold = holdState[treeId];
    if (hold.counter < hold.loops) {
      hold.counter += 1;
      const deviation = ecologyFor(treeId)?.deviation ?? {};
      const adaptiveEntry = ['branchChanges', 'meanDwell', 'cohortSize']
        .map((metric) => ({ metric, direction: typeof deviation[metric] === 'string'
          ? deviation[metric] : deviation[metric]?.direction }))
        .find(({ direction }) => direction === 'low' || direction === 'high');
      if (adaptiveEntry && plan.mutations.length) {
        const adjacent = plan.mutations.filter((m) => Math.abs(m.to - m.from) === 1);
        const rest = plan.mutations.filter((m) => Math.abs(m.to - m.from) !== 1);
        const mutations = [...adjacent, ...rest].slice(0, 1);
        const metricLabel = {
          branchChanges: '换枝', meanDwell: '驻留', cohortSize: '群聚',
        }[adaptiveEntry.metric] ?? adaptiveEntry.metric;
        const directionLabel = adaptiveEntry.direction === 'low' ? '偏低' : '偏高';
        return {
          plan: {
            ...plan,
            mutations,
            reason: `${plan.reason} · 保持期软适应:${metricLabel}${directionLabel}`,
          },
          held: true,
          softened: true,
          holdLeft: hold.loops - hold.counter,
        };
      }
      return { plan: { ...plan, mutations: [] }, held: true, holdLeft: hold.loops - hold.counter };
    }
    // 期满小变：邻枝优先、上限收紧、禁整句重掷
    const adjacent = plan.mutations.filter((m) => Math.abs(m.to - m.from) === 1);
    const rest = plan.mutations.filter((m) => Math.abs(m.to - m.from) !== 1);
    let picked = [...adjacent, ...rest].slice(0, config.agent.holdMutationMax);
    picked = ensurePatternMutation(picked, tree?.birds ?? [], config.tree.branches.length, rng)
      .slice(0, config.agent.holdMutationMax);
    const [holdMin, holdMax] = config.agent.holdLoopsRange;
    hold.loops = Number.isInteger(plan.holdLoops)
      ? clamp(plan.holdLoops, holdMin, holdMax)
      : config.agent.defaultHoldLoops;
    // 变异发生的本轮不计入新保持期；下一轮才是 H 个完整 suppress 循环中的第 1 轮。
    hold.counter = 0;
    return { plan: { ...plan, mutations: picked }, held: false, expired: true, nextLoops: hold.loops };
  }

  // 黎明前钩子（归巢规划之前）：季节翻转 → master → harmonicFrame →（换季才）迁移
  // → flock 计划生效 → 发起复盘。色彩档日变只改高枝音，不强制迁移家枝。
  world.onBeforeDawn(({ day, stats }) => {
    patternHistory.push(patternOf(world.getSnapshot()));
    settleHarmonyCounts(); // H 日终入账：在鸣时长并入刚结束的一天
    pushScoreHistories(); // 分数短历史：须在 masterInput 之前，含刚结束当天

    // 0) 季节翻转：昨天是季末日 → 今天入新季（master 预告优先，否则菜单顺挂）
    const wasFinalDay = cursor.seasonDay >= cursor.seasonLength - 1;
    let seasonChanged = false;
    if (wasFinalDay) {
      cursor.seasonIdx = pendingNext?.seasonIdx ?? (cursor.seasonIdx + 1) % config.harmony.seasons.length;
      cursor.seasonLength = pendingNext?.seasonLength ?? config.harmony.defaultSeasonLength;
      cursor.seasonDay = 0;
      cursor.daysSinceChange = 0;
      pendingNext = null;
      seasonChanged = true;
    } else {
      cursor.seasonDay += 1;
      cursor.daysSinceChange += 1;
    }
    const isFinalDay = cursor.seasonDay >= cursor.seasonLength - 1;

    const mInput = masterInput(stats);

    // 1) 领取流水线结果（flock + master，未就绪内部已回落）+ master 决策
    const dawnResult = pipelineRef ? pipelineRef.dawnPlan() : null;
    const masterDecision = dawnResult ? dawnResult.master.decision : decideMaster(mInput);
    const masterSource = dawnResult ? dawnResult.master.source : '规则层';

    // 2) 换季预告：季末日决策带的 nextSeason/seasonLength 存下，次日黎明生效
    if (isFinalDay && typeof masterDecision?.nextSeason === 'string') {
      const idx = config.harmony.seasons.indexOf(masterDecision.nextSeason);
      if (idx >= 0 && idx !== cursor.seasonIdx) {
        const [lo, hi] = config.llm.seasonLengthRange;
        pendingNext = {
          seasonIdx: idx,
          seasonLength: Number.isInteger(masterDecision.seasonLength)
            ? clamp(masterDecision.seasonLength, lo, hi)
            : config.harmony.defaultSeasonLength,
        };
      }
    }

    // 3) 构建今日 harmonicFrame（上游给 color/tension 则用，否则规则兜底）→ 当日和弦
    const prevChord = currentChord;
    currentFrame = buildFrame(masterDecision);
    currentChord = chordFromFrame(currentFrame, config.harmony);
    commitColorState(currentFrame.color.id); // P1：回填 currentColorId/daysInColor
    pushBranchPreferences(); // 当日 tension 生效后立即下发枝权重
    pushVocalizeBiases(); // Track B：昨日错峰缺口 → 今日发声偏置（须在 pattern 定员前）
    onMaster?.({
      day, decision: masterDecision, source: masterSource, frame: currentFrame, chord: currentChord, seasonChanged,
    });

    // 4) 家枝迁移：只在换季日大迁移（voice-leading + seasonMigrationOnly 成批搬家）；
    //    季末日（非换季日）bass 收换季预告、提前聚集到最低允许枝，次日领迁移。
    const snap = world.getSnapshot();
    const migrations = [];
    if (seasonChanged) {
      for (const treeSnap of snap.trees) {
        if (config.species[treeSnap.species]?.seasonMigrationOnly) continue;
        const assignments = treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch }));
        const moves = migrateAssignments(prevChord, currentChord, assignments);
        for (const m of moves) {
          if (m.to !== m.from) {
            world.setHomeBranch(m.birdId, m.to);
            migrations.push({ treeId: treeSnap.id, ...m });
          }
        }
      }
      if (typeof world.applySeasonChange === 'function') {
        migrations.push(...world.applySeasonChange(day));
      }
    } else if (isFinalDay) {
      for (const treeSnap of snap.trees) {
        const sp = config.species[treeSnap.species];
        if (!sp?.seasonMigrationOnly) continue;
        const rally = Math.min(...(sp.allowedBranches ?? [0]));
        for (const bird of treeSnap.birds) {
          if (bird.homeBranch !== rally && world.setHomeBranch(bird.id, rally)) {
            migrations.push({
              treeId: treeSnap.id, birdId: bird.id, from: bird.homeBranch, to: rally, rally: true,
            });
          }
        }
      }
    }

    // 3) flock 计划生效（按树）：evaluator 钩子 > pipeline LLM > 规则兜底
    // USER 接管树跳过计划/变异（换季迁移已在上方完成，生态/master 照常）。
    const appliedPlans = {};
    const dropped = [];
    for (const treeSnap of snap.trees) {
      if (typeof world.getTreeControl === 'function' && world.getTreeControl(treeSnap.id) === 'USER') {
        appliedPlans[treeSnap.id] = {
          plan: {
            dwellBeats: treeSnap.dwellBeats,
            activeBars: treeSnap.activeBars,
            holdLoops: config.agent.defaultHoldLoops,
            mutations: [],
            densityTier: treeSnap.densityTier,
            reason: 'USER 接管：跳过计划/变异',
          },
          source: 'USER',
          reviewedDay: stats.day,
          held: { held: false, seasonOnly: false },
          dropped: [],
        };
        continue;
      }
      const treeStats = stats.trees[treeSnap.id];
      let plan;
      let source;
      let reviewedDay = stats.day;
      if (evaluator) {
        plan = pendingPlan?.[treeSnap.id];
        source = pendingSource;
        reviewedDay = pendingReviewedDay ?? stats.day;
        if (!plan) { plan = rulePlan(treeSnap, treeStats); source = '规则层(即时兜底)'; reviewedDay = stats.day; }
      } else if (dawnResult && !dawnResult.flock.fallback && dawnResult.flock.plan) {
        const flockIdx = config.trees.findIndex((t) => t.id === treeSnap.id);
        const flockPlan = { flocks: [dawnResult.flock.plan.flocks?.[flockIdx]].filter(Boolean) };
        plan = flockPlan.flocks.length
          ? planFromLlm(flockPlan, treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch })),
            treeStats, { ...config.agent, branchCount: config.tree.branches.length })
          : null;
        if (!plan) { plan = rulePlan(treeSnap, treeStats); source = '规则层(兜底)'; } else source = 'LLM';
        reviewedDay = dawnResult.reviewedDay ?? stats.day;
      } else {
        plan = rulePlan(treeSnap, treeStats);
        source = dawnResult ? '规则层(兜底)' : '规则层';
      }
      const bounded = filterMutationBounds(plan.mutations, config.tree.branches.length);
      const droppedForTree = [...(plan.droppedMutations ?? []), ...bounded.dropped];
      plan = { ...plan, mutations: bounded.accepted };
      // 乐句保持期（melody）：保持期内只冻家枝变异，期满小变。
      const held = applyHoldLoops(treeSnap.id, plan);
      plan = held.plan;
      const appliedMutations = [];
      for (const m of plan.mutations) {
        if (world.setHomeBranch(m.birdId, m.to)) appliedMutations.push(m);
        else droppedForTree.push({ ...m, reason: 'world-rejected' });
      }
      plan = { ...plan, mutations: appliedMutations };
      world.setDensityTier(treeSnap.id, plan.densityTier);
      world.setFlockPlan(treeSnap.id, { dwellBeats: plan.dwellBeats, activeBars: plan.activeBars });
      const droppedEntries = droppedForTree.map((entry) => ({ treeId: treeSnap.id, ...entry }));
      dropped.push(...droppedEntries);
      appliedPlans[treeSnap.id] = { plan, source, reviewedDay, held: { ...held, plan }, dropped: droppedEntries };
    }
    if (evaluator) { pendingPlan = null; pendingSource = null; pendingReviewedDay = null; }

    onApply?.({ plans: appliedPlans, day, migrations, dropped, prevChord, nextChord: currentChord });
    if (prevChord.id !== currentChord.id || prevChord.season !== currentChord.season) {
      onChord?.({ day, prevChord, nextChord: currentChord });
    }

    // 5) 发起当天复盘（第 N 天复盘第 N−1 天 → 第 N+1 天生效），随后重置 H 计数：
    //    ecology 通道的 onBeforeDawn 注册先于本钩子，读到的仍是刚结束当天的完整计数。
    if (pipelineRef) {
      pipelineRef.dayReview({ day: stats.day, flockSnapshot: flockInput(stats), masterInput: mInput });
    } else if (evaluator) {
      runEvaluation(stats);
    }
    resetHarmonyCounts();
  });

  return {
    getChord: () => currentChord,
    getFrame: () => currentFrame,
    getHarmonyScores: () => harmonyScores(),
    hasPendingPlan: () => !!pendingPlan,
    setPipeline: (p) => { pipelineRef = p; },
    getHoldState: (treeId) => ({ ...holdState[treeId] }),
  };
}
