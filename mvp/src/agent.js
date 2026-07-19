// mvp/src/agent.js —— 日界变奏 agent + 评估流水线 + master 决策（Phase 1.8）。
// 时序（§3.5.1.4）：第 N 天全天，agent 复盘第 N−1 天的完整数据 → 当天内产出计划
// → 第 N+1 天黎明随换和弦一起生效。LLM 真实接线经 mvp/src/llm/integration.js 的
// createAgentPipeline（白天 dayReview、黎明 dawnPlan 领取、未就绪规则兜底）；
// master（季节/进行步骤）决策同理：llm-master 个性层 + policy.js 兜底。
//
// evaluateDay 是纯函数规则层；attachPipelineConductor 负责接线（DOM-free，可测）。
// 只引用生态词汇——换和弦与家枝迁移由 harmony.js 提供，conductor 只做编排。

import { CONFIG } from './config.js';
import { chordForDay, seasonForDay, migrateAssignments } from './harmony.js';
import { decideMaster } from './master/policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const TIER_ORDER = ['sparse', 'normal', 'full'];
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

// 规则层日评估（纯函数）。dayStats：world 黎明事件载荷里的日终统计。
// assignments：[{birdId, homeBranch}]。cfg：{...CONFIG.agent, branchCount, dwellBase}。
export function evaluateDay(dayStats, assignments, cfg, rng = Math.random) {
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
  if (mutations.length < cfg.maxMutationsPerDay && rng() < cfg.roamMutationChance) {
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

  // 规则 D dwell 基线：当日平均驻留偏离物种尺度 → 明日微调。
  // 双树统计不携带 dwellBaseline：从当日生效的 dwellBeats 反推，缺省 1（防 NaN）。
  let dwellBaseline = Number.isFinite(dayStats.dwellBaseline)
    ? dayStats.dwellBaseline
    : (cfg.dwellBase > 0 && Number.isFinite(dayStats.dwellBeats)
      ? clamp(dayStats.dwellBeats / cfg.dwellBase, cfg.dwellBaselineMin, cfg.dwellBaselineMax)
      : 1);
  const expectLow = cfg.dwellBase * cfg.dwellExpectLowFactor;
  const expectHigh = cfg.dwellBase * cfg.dwellExpectHighFactor;
  // 比较口径统一为拍：dwellBase 是拍，meanDwell（秒）只在旧统计缺拍字段时兜底。
  const meanDwellBeats = Number.isFinite(dayStats.meanDwellBeats)
    ? dayStats.meanDwellBeats : dayStats.meanDwell;
  if (dayStats.dwellSampleCount > 0 && meanDwellBeats < expectLow) {
    dwellBaseline = clamp(dwellBaseline + cfg.dwellBaselineStep, cfg.dwellBaselineMin, cfg.dwellBaselineMax);
    if (dwellBaseline !== dayStats.dwellBaseline) reasons.push(`驻留:偏短（${meanDwellBeats.toFixed(1)}拍），基线→${dwellBaseline.toFixed(2)}`);
  } else if (dayStats.dwellSampleCount > 0 && meanDwellBeats > expectHigh) {
    dwellBaseline = clamp(dwellBaseline - cfg.dwellBaselineStep, cfg.dwellBaselineMin, cfg.dwellBaselineMax);
    if (dwellBaseline !== dayStats.dwellBaseline) reasons.push(`驻留:偏长（${meanDwellBeats.toFixed(1)}拍），基线→${dwellBaseline.toFixed(2)}`);
  }

  if (!reasons.length) reasons.push('保持：今日 pattern 均衡，明日原样循环');
  return { mutations, densityTier, dwellBaseline, reason: reasons.join('；') };
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

// master 菜单：由 config 的 progression/季节色彩构造（每季当前仅 'base' 一条路径）
export function masterMenuFromConfig(cfg = CONFIG) {
  const { seasons, progressions } = cfg.harmony;
  return {
    progressions: seasons.map((s) => progressions[s].map((c) => c.id)),
    seasonPalettes: Object.fromEntries(seasons.map((s) => [s, ['base']])),
    seasonLengthRange: cfg.llm.seasonLengthRange,
    cooldownDays: cfg.llm.masterCooldownDays,
  };
}

// 游标处的当日和弦（cursor = {seasonIdx, stepIdx}）
function chordAtCursor(cursor, cfg = CONFIG.harmony) {
  const seasonId = cfg.seasons[cursor.seasonIdx];
  const chord = cfg.progressions[seasonId][cursor.stepIdx % cfg.progressions[seasonId].length];
  return {
    id: chord.id,
    notes: chord.intervals.map((i) => chord.root + i),
    season: seasonId,
    seasonName: cfg.seasonNames[seasonId],
  };
}

// 评估流水线接线（双树版）。
// pipeline：createAgentPipeline 产物（{dayReview, dawnPlan}），可为 null（纯规则）。
// evaluator：遗留测试钩子（async (stats, ctx) => plan），提供时优先于 pipeline 的 flock 通道。
// 回调：onPlan / onApply / onChord / onMaster（均带决策来源标签）。
// holdLoops（§3.5.3.3）：melody 的 pattern 在保持期内不做日界变异，期满小变
// （≤holdMutationMax、邻枝优先、禁整句重掷）；和弦照常推进、家枝按音级迁移。
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
  // 和声游标：master 决策可跳步/换季，否则按季节钟与进行顺走
  const cursor = {
    seasonIdx: seasonForDay(world.getSnapshot().day, config.harmony).index,
    stepIdx: (world.getSnapshot().day - 1) % config.harmony.progressions[config.harmony.seasons[0]].length,
    daysInSeason: 1,
    daysSinceChange: 0,
  };
  let currentChord = chordAtCursor(cursor, config.harmony);
  let pendingPlan = null;   // evaluator 钩子路径的待生效计划（按树：{treeId: plan}）
  let pendingSource = null;
  let pendingReviewedDay = null;
  const patternHistory = []; // 每日家枝 pattern（算相似度给 master 观测）
  // 乐句保持期状态（按树）：{counter, loops}；counter 从 0 计，首个期满在默认 H 后
  const holdState = Object.fromEntries(config.trees.map((t) => [t.id, {
    counter: 0,
    loops: config.agent.defaultHoldLoops,
  }]));

  // 规则层计划（按树）：契约 {dwellBeats, activeBars, holdLoops, mutations[], densityTier, reason}
  const rulePlan = (treeSnap, treeStats) => {
    const sp = config.species[treeSnap.species];
    const base = evaluateDay(treeStats,
      treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch })),
      { ...config.agent, branchCount: config.tree.branches.length, dwellBase: sp.dwellBeats },
      rng);
    const [holdMin, holdMax] = config.agent.holdLoopsRange;
    const holdLoops = Math.round(holdMin + rng() * (holdMax - holdMin)); // agent 范围内自选
    return {
      mutations: base.mutations,
      densityTier: base.densityTier,
      dwellBeats: sp.dwellBeats * base.dwellBaseline,
      activeBars: config.tempo.barsPerDay,
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
        currentProgression: cursor.seasonIdx,
        currentStep: cursor.stepIdx,
        daysInSeason: cursor.daysInSeason,
        daysSinceChange: cursor.daysSinceChange,
      },
      observations: {
        treeScores: snap.trees.map((t) => {
          const score = Number(ecologyFor(t.id)?.score);
          return Number.isFinite(score) ? score : t.meanEnergy;
        }),
        patternSimilarity: meanTreePatternSimilarity(prev, now),
      },
    };
  }

  function flockInput(stats) {
    const snap = world.getSnapshot();
    return {
      day: stats.day,
      dayPhase: 'dawn',
      season: currentChord.season,
      flocks: snap.trees.map((t) => {
        const ecology = ecologyFor(t.id);
        return {
          species: t.species,
          energy: t.meanEnergy,
          perchFlyRatio: t.birds.length ? t.perchedTotal / t.birds.length : 0,
          treeCondition: { health: t.meanEnergy },
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
        plans = await evaluator(stats, { chord: currentChord.id });
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

  // 乐句保持期只冻结 melody 的家枝变异；dwell/active/density 仍可随日评估更新。
  function applyHoldLoops(treeId, plan) {
    const sp = world.getSnapshot().trees.find((t) => t.id === treeId)?.species;
    if (config.species[sp]?.seasonMigrationOnly) {
      return { plan: { ...plan, mutations: [] }, held: true, seasonOnly: true };
    }
    if (sp !== 'melody') return { plan, held: false };
    const hold = holdState[treeId];
    if (hold.counter < hold.loops) {
      hold.counter += 1;
      return { plan: { ...plan, mutations: [] }, held: true, holdLeft: hold.loops - hold.counter };
    }
    // 期满小变：邻枝优先、上限收紧、禁整句重掷
    const adjacent = plan.mutations.filter((m) => Math.abs(m.to - m.from) === 1);
    const rest = plan.mutations.filter((m) => Math.abs(m.to - m.from) !== 1);
    const picked = [...adjacent, ...rest].slice(0, config.agent.holdMutationMax);
    const [holdMin, holdMax] = config.agent.holdLoopsRange;
    hold.loops = Number.isInteger(plan.holdLoops)
      ? clamp(plan.holdLoops, holdMin, holdMax)
      : config.agent.defaultHoldLoops;
    // 变异发生的本轮不计入新保持期；下一轮才是 H 个完整 suppress 循环中的第 1 轮。
    hold.counter = 0;
    return { plan: { ...plan, mutations: picked }, held: false, expired: true, nextLoops: hold.loops };
  }

  // 黎明前钩子（归巢规划之前）：master → 换和弦 → 家枝迁移 → flock 计划生效 → 发起复盘
  world.onBeforeDawn(({ day, stats }) => {
    patternHistory.push(patternOf(world.getSnapshot()));
    const mInput = masterInput(stats);

    // 0) 领取流水线结果（flock + master，未就绪内部已回落）
    const dawnResult = pipelineRef ? pipelineRef.dawnPlan() : null;

    // 1) master 决策 → 和声游标
    const masterDecision = dawnResult ? dawnResult.master.decision : decideMaster(mInput);
    const masterSource = dawnResult ? dawnResult.master.source : '规则层';
    const prevChord = currentChord;
    let seasonChanged = false;
    if (masterDecision?.changeSeason) {
      const idx = config.harmony.seasons.indexOf(masterDecision.changeSeason);
      if (idx >= 0 && idx !== cursor.seasonIdx) {
        cursor.seasonIdx = idx;
        cursor.stepIdx = 0;
        cursor.daysSinceChange = 0;
        seasonChanged = true;
      }
    }
    if (!seasonChanged) {
      // 季节钟：到期换季（基础节拍）；master 的 changeSeason 是提前干预
      const clockSeason = seasonForDay(day, config.harmony).index;
      if (clockSeason !== cursor.seasonIdx) {
        cursor.seasonIdx = clockSeason;
        cursor.stepIdx = 0;
        seasonChanged = true;
      } else if (masterDecision && Number.isInteger(masterDecision.jumpToStep)) {
        cursor.stepIdx = masterDecision.jumpToStep;
      } else {
        cursor.stepIdx = (cursor.stepIdx + 1) % config.harmony.progressions[config.harmony.seasons[cursor.seasonIdx]].length;
      }
    }
    cursor.daysInSeason = seasonChanged ? 1 : cursor.daysInSeason + 1;
    cursor.daysSinceChange += 1;
    currentChord = chordAtCursor(cursor, config.harmony);
    onMaster?.({ day, decision: masterDecision, source: masterSource, chord: currentChord, seasonChanged });

    // 2) 换和弦 → 家枝最近音级迁移（voice-leading，两树各自迁移）
    const snap = world.getSnapshot();
    const migrations = [];
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
    if (seasonChanged && typeof world.applySeasonChange === 'function') {
      migrations.push(...world.applySeasonChange(day));
    }

    // 3) flock 计划生效（按树）：evaluator 钩子 > pipeline LLM > 规则兜底
    const appliedPlans = {};
    const dropped = [];
    for (const treeSnap of snap.trees) {
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

    // 4) 发起当天复盘（第 N 天复盘第 N−1 天 → 第 N+1 天生效）
    if (pipelineRef) {
      pipelineRef.dayReview({ day: stats.day, flockSnapshot: flockInput(stats), masterInput: mInput });
    } else if (evaluator) {
      runEvaluation(stats);
    }
  });

  return {
    getChord: () => currentChord,
    hasPendingPlan: () => !!pendingPlan,
    setPipeline: (p) => { pipelineRef = p; },
    getHoldState: (treeId) => ({ ...holdState[treeId] }),
  };
}
