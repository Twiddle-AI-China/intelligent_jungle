// mvp/src/deterministic-conductor.js —— provider-free 确定性 conductor core。
// 时序（§3.5.1.4）：第 N 天全天，agent 复盘第 N−1 天的完整数据 → 当天内产出计划
// → 第 N+1 天黎明随换和弦一起生效。LLM 真实接线经 mvp/src/llm/integration.js 的
// createAgentPipeline（白天 dayReview、黎明 dawnPlan 领取、未就绪规则兜底）。
// 和声：季 = 四和弦日进行 × 两圈，昼夜 = 同日和弦的色彩档；
// conductor 每黎明构建 harmonicFrame{season, seasonDay, seasonLength, skeleton,
// color, tension}（上游 dawnPlan 提供 color/tension/seasonLength 则用之，否则规则兜底），
// 只在换季日做家枝大迁移；和谐分 H 只观测（骨架 1.0/色彩 0.7/框架外 0），不进计分。
//
// evaluateDay 是纯函数规则层；attachPipelineConductor 负责接线（DOM-free，可测）。
// 只引用生态词汇——骨架/色彩与家枝迁移由 harmony.js 提供，conductor 只做编排。

import { CONFIG } from './config.js';
import { skeletonForSeason, colorOptions, chordFromFrame, migrateAssignments } from './harmony.js';
import { decideMaster } from './master/policy.js';
import { jungleEditPlan } from './jungle.js';
import { normalizeSurvivalAction } from './survival-actions.js';
import {
  applySequenceCellMutations,
  createSequencePatternBridge,
  sequencePatternSummary,
} from './sequence.js';

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

export function resolveBehaviorSuggestions(suggestions = []) {
  const resolved = {};
  for (const dimension of ['density', 'dwell', 'activeBars']) {
    const rows = suggestions.filter((row) => row.dimension === dimension && Number(row.delta));
    if (!rows.length) continue;
    const priority = Math.max(...rows.map((row) => Number(row.priority) || 0));
    const peers = rows.filter((row) => (Number(row.priority) || 0) === priority);
    const net = peers.reduce((sum, row) => sum + Math.sign(Number(row.delta)), 0);
    if (!net) continue;
    resolved[dimension] = {
      delta: Math.sign(net),
      priority,
      reasons: peers.filter((row) => Math.sign(Number(row.delta)) === Math.sign(net))
        .map((row) => row.reason).filter(Boolean),
    };
  }
  return resolved;
}

export function meanTreePatternSimilarity(previous = {}, current = {}) {
  const treeIds = Object.keys(current).filter((treeId) => previous[treeId] != null);
  if (!treeIds.length) return 0;
  const scores = treeIds.map((treeId) => {
    const before = previous[treeId];
    const after = current[treeId];
    // Sequence v2：按非空起音格的加权 Jaccard 计算，避免 80 格中大量共同空格
    // 把两条完全不同的稀疏乐句误判为高度相似。count 表示同格复音数。
    if (Array.isArray(before?.occupiedCells) && Array.isArray(after?.occupiedCells)) {
      const toCounts = (summary) => new Map(summary.occupiedCells.map((cell) => [
        `${cell.pitchBranchId}:${cell.stepIndex}`,
        Math.max(1, Number(cell.count) || 1),
      ]));
      const a = toCounts(before);
      const b = toCounts(after);
      const keys = new Set([...a.keys(), ...b.keys()]);
      if (!keys.size) return 1;
      let intersection = 0;
      let union = 0;
      for (const key of keys) {
        intersection += Math.min(a.get(key) ?? 0, b.get(key) ?? 0);
        union += Math.max(a.get(key) ?? 0, b.get(key) ?? 0);
      }
      return union > 0 ? intersection / union : 1;
    }
    // 旧家枝数组仅保留给旧存档/调用方兼容。
    if (!Array.isArray(before) || !Array.isArray(after) || !before.length || before.length !== after.length) return 0;
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

// 和谐分 H（只观测不进 economy）：按骨架/色彩/框架外权重直接求加权平均。
// 不重定标，避免合法色彩发音被映射成 0 并触发 master 低分增色的反向反馈。
// 无发音返回 null（观测缺失，非 0 分）。第三参保留以兼容旧调用方。
export function harmonyScoreFromCounts(
  counts,
  weights = CONFIG.harmony.harmonyWeights,
  _legacyRescaleFloor,
) {
  const skeleton = counts?.skeleton ?? 0;
  const color = counts?.color ?? 0;
  const outside = counts?.outside ?? 0;
  const total = skeleton + color + outside;
  if (!total) return null;
  const raw = (skeleton * weights.skeleton + color * weights.color + outside * weights.outside) / total;
  return clamp(raw, 0, 1);
}

// 规则兜底的 Sequence 小变：默认每 holdLoops 个已复盘日移动一个 onset，
// 优先同音高向后挪一格，再尝试邻音高同拍；找不到空格就原样保持。
export function ruleSequencePlan(summary, reviewedDay, {
  holdLoops = CONFIG.agent.defaultHoldLoops,
  maxMutations = CONFIG.agent.maxMutationsPerDay,
  preferJungleGrid = false,
  onsetCountDirection = 'within',
  regularityDirection = 'within',
  roleDiversityDirection = 'within',
  gridDriftBand = null,
  gridDriftMinSimilarity = CONFIG.agent.gridDrift?.minDaySimilarity ?? 0.5,
  pitchBranchWeights = null,
} = {}) {
  if (!summary || summary.version !== 2 || !Array.isArray(summary.occupiedCells)) return null;
  const day = Math.max(0, Math.floor(Number(reviewedDay) || 0));
  const period = Math.max(1, Math.floor(Number(holdLoops) || 1));
  const occupied = new Set(summary.occupiedCells.map(
    (cell) => `${cell.pitchBranchId}:${cell.stepIndex}`,
  ));
  const sources = [...summary.occupiedCells].sort(
    (a, b) => a.stepIndex - b.stepIndex || a.pitchBranchId - b.pitchBranchId,
  );

  // 同拍复音会让多个 Amen 片相位叠加。先把同一 step 的第二格搬到空的整拍，
  // 强拍 0/4/8/12 优先，其次偶数拍，最后才用其余拍。
  const usedSteps = new Set(sources.map((cell) => cell.stepIndex));
  const stepCounts = new Map();
  for (const cell of sources) stepCounts.set(cell.stepIndex, (stepCounts.get(cell.stepIndex) ?? 0) + 1);
  const duplicate = sources.find((cell) => (stepCounts.get(cell.stepIndex) ?? 0) > 1
    && sources.find((candidate) => candidate.stepIndex === cell.stepIndex) !== cell);
  if (preferJungleGrid && duplicate) {
    const targetStep = [0, 4, 8, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15]
      .find((stepIndex) => stepIndex < summary.stepCount && !usedSteps.has(stepIndex));
    if (Number.isInteger(targetStep)) {
      return applySequenceCellMutations(summary, [{
        from: { pitchBranchId: duplicate.pitchBranchId, stepIndex: duplicate.stepIndex },
        to: { pitchBranchId: duplicate.pitchBranchId, stepIndex: targetStep },
      }], { maxMutations });
    }
  }

  // Jungle 起音不足时，规则 Agent 每日最多补 maxMutations 个经典切分位置。
  // 旧 move-only 变异无法提高占空比，会让 2–4 个孤立 slice 永久循环；补点仍然
  // 走完整 Sequence summary → world 安全校验，不在音频层偷偷加音。
  if (preferJungleGrid && onsetCountDirection === 'low') {
    const usedPitches = new Set(sources.map((cell) => cell.pitchBranchId));
    const stepOrder = [0, 4, 8, 12, 2, 6, 10, 14, 3, 7, 11, 15, 1, 5, 9, 13]
      .filter((stepIndex) => stepIndex < summary.stepCount && !usedSteps.has(stepIndex));
    const pitchOrder = [2, 1, 3, 0, 4]
      .filter((pitchBranchId) => pitchBranchId < summary.pitchBranchCount);
    const additions = [];
    for (const stepIndex of stepOrder) {
      if (additions.length >= maxMutations) break;
      const pitchBranchId = pitchOrder.find((pitch) => !usedPitches.has(pitch))
        ?? pitchOrder[(sources.length + additions.length) % pitchOrder.length]
        ?? 0;
      additions.push({ pitchBranchId, stepIndex, count: 1 });
      usedPitches.add(pitchBranchId);
    }
    if (additions.length) {
      return {
        summary: {
          ...summary,
          occupiedCells: [...sources, ...additions].sort(
            (a, b) => a.stepIndex - b.stepIndex || a.pitchBranchId - b.pitchBranchId,
          ),
        },
        mutations: [],
        additions,
      };
    }
  }

  // 非 Jungle 声部的最小网格漂移：每天只增或删一个唯一 onset，逐日逼近物种偏好带。
  // 该层不取代最多两次 cell move；当前实现使用 1/3 总预算，保留其余预算给搬移。
  if (!preferJungleGrid && Array.isArray(gridDriftBand) && gridDriftBand.length >= 2) {
    const lo = Math.max(0, Math.floor(Number(gridDriftBand[0]) || 0));
    const hi = Math.max(lo, Math.floor(Number(gridDriftBand[1]) || lo));
    const onsetCount = usedSteps.size;
    let nextCells = null;
    let additions = [];
    let removals = [];
    if (onsetCount < lo) {
      const stepIndex = [0, 4, 8, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15]
        .find((step) => step < summary.stepCount && !usedSteps.has(step));
      if (Number.isInteger(stepIndex)) {
        const pitchLoads = Array.from({ length: summary.pitchBranchCount }, (_, pitchBranchId) => ({
          pitchBranchId,
          count: sources.filter((cell) => cell.pitchBranchId === pitchBranchId).length,
          preference: Number(pitchBranchWeights?.[pitchBranchId] ?? 1),
        })).sort((a, b) => a.count - b.count || b.preference - a.preference || a.pitchBranchId - b.pitchBranchId);
        const addition = { pitchBranchId: pitchLoads[0]?.pitchBranchId ?? 0, stepIndex, count: 1 };
        additions = [addition];
        nextCells = [...sources, addition];
      }
    } else if (onsetCount > hi) {
      const removable = [...sources]
        .filter((cell) => stepCounts.get(cell.stepIndex) === 1)
        .sort((a, b) => {
          const aStrong = a.stepIndex % 4 === 0 ? 1 : 0;
          const bStrong = b.stepIndex % 4 === 0 ? 1 : 0;
          return aStrong - bStrong || b.stepIndex - a.stepIndex || b.pitchBranchId - a.pitchBranchId;
        })[0];
      if (removable && onsetCount - 1 >= hi) {
        removals = [{ ...removable }];
        nextCells = sources.filter((cell) => cell !== removable);
      }
    }
    if (nextCells) {
      const beforeKeys = new Set(sources.map((cell) => `${cell.pitchBranchId}:${cell.stepIndex}`));
      const afterKeys = new Set(nextCells.map((cell) => `${cell.pitchBranchId}:${cell.stepIndex}`));
      const union = new Set([...beforeKeys, ...afterKeys]);
      const intersection = [...beforeKeys].filter((key) => afterKeys.has(key)).length;
      // 空网格冷启动没有可被破坏的既有乐句；首个 onset 视作安全引导。
      const similarity = !beforeKeys.size ? 1 : union.size ? intersection / union.size : 1;
      if (similarity >= clamp(Number(gridDriftMinSimilarity) || 0, 0, 1)) {
        return {
          summary: {
            ...summary,
            occupiedCells: nextCells.sort(
              (a, b) => a.stepIndex - b.stepIndex || a.pitchBranchId - b.pitchBranchId,
            ),
          },
          mutations: [],
          additions,
          removals,
          gridDrift: { onsetCount, nextOnsetCount: onsetCount + additions.length - removals.length, similarity },
        };
      }
    }
  }

  if (!sources.length) return applySequenceCellMutations(summary, [], { maxMutations });

  // 打击生态角色不足时，保留时间位置，只把重复角色的一格迁到未使用角色。
  // 这不会凭空加鼓点，也不会破坏一日一格的原子变异上限。
  if (roleDiversityDirection === 'low') {
    const roleCount = new Map();
    for (const cell of sources) roleCount.set(cell.pitchBranchId, (roleCount.get(cell.pitchBranchId) ?? 0) + 1);
    const targetRole = Array.from({ length: summary.pitchBranchCount }, (_, i) => i)
      .find((role) => !roleCount.has(role));
    const source = sources.find((cell) => (roleCount.get(cell.pitchBranchId) ?? 0) > 1
      && !occupied.has(`${targetRole}:${cell.stepIndex}`));
    if (source && Number.isInteger(targetRole)) {
      return applySequenceCellMutations(summary, [{
        from: { pitchBranchId: source.pitchBranchId, stepIndex: source.stepIndex },
        to: { pitchBranchId: targetRole, stepIndex: source.stepIndex },
      }], { maxMutations });
    }
  }

  // Bass 间隔规律偏低时，把最密相邻起音中的一个移到最大空隙中点。
  // 只移动一个既有 cell，不增删音符，也不越过 Sequence 的原子变异契约。
  if (regularityDirection === 'low') {
    const steps = [...new Set(sources.map((cell) => cell.stepIndex))].sort((a, b) => a - b);
    if (steps.length >= 2) {
      const gaps = steps.map((from, index) => {
        const to = steps[(index + 1) % steps.length];
        return { from, to, size: (to - from + summary.stepCount) % summary.stepCount || summary.stepCount };
      });
      const largest = [...gaps].sort((a, b) => b.size - a.size || a.from - b.from)[0];
      const targetStep = (largest.from + Math.max(1, Math.round(largest.size / 2))) % summary.stepCount;
      const stepCounts = new Map();
      for (const cell of sources) stepCounts.set(cell.stepIndex, (stepCounts.get(cell.stepIndex) ?? 0) + 1);
      // 必须移走某个唯一 onset；若从复音 step 只移一格，原 step 仍占用，
      // 唯一时间集合不变，规律度就不会真的改善。
      const sourceStep = [...gaps]
        .sort((a, b) => a.size - b.size || a.from - b.from)
        .flatMap((gap) => [gap.to, gap.from])
        .find((step) => stepCounts.get(step) === 1 && step !== targetStep);
      const source = sources.find((cell) => cell.stepIndex === sourceStep);
      if (source && !steps.includes(targetStep)) {
        return applySequenceCellMutations(summary, [{
          from: { pitchBranchId: source.pitchBranchId, stepIndex: source.stepIndex },
          to: { pitchBranchId: source.pitchBranchId, stepIndex: targetStep },
        }], { maxMutations });
      }
    }
  }

  if (day === 0 || day % period !== 0) return applySequenceCellMutations(summary, [], { maxMutations });
  const source = sources[(Math.floor(day / period) - 1) % sources.length];
  const candidates = [];
  // 奇数保持期先做邻音高，偶数保持期先做时间位移，避免规则层永远只改一个轴。
  const pitchFirst = Math.floor(day / period) % 2 === 1;
  const timeCandidates = Array.from({ length: Math.max(0, summary.stepCount - 1) }, (_, index) => ({
    pitchBranchId: source.pitchBranchId,
    stepIndex: (source.stepIndex + index + 1) % summary.stepCount,
  }));
  const pitchCandidates = [];
  for (const pitchOffset of [-1, 1, -2, 2]) {
    const pitchBranchId = source.pitchBranchId + pitchOffset;
    if (pitchBranchId >= 0 && pitchBranchId < summary.pitchBranchCount) {
      pitchCandidates.push({ pitchBranchId, stepIndex: source.stepIndex });
    }
  }
  pitchCandidates.sort((a, b) => (
    Number(pitchBranchWeights?.[b.pitchBranchId] ?? 1)
      - Number(pitchBranchWeights?.[a.pitchBranchId] ?? 1)
  ) || Math.abs(a.pitchBranchId - source.pitchBranchId) - Math.abs(b.pitchBranchId - source.pitchBranchId));
  candidates.push(...(pitchFirst ? [...pitchCandidates, ...timeCandidates] : [...timeCandidates, ...pitchCandidates]));
  const target = candidates.find((address) => !occupied.has(`${address.pitchBranchId}:${address.stepIndex}`));
  if (!target) return applySequenceCellMutations(summary, [], { maxMutations });
  return applySequenceCellMutations(summary, [{
    from: { pitchBranchId: source.pitchBranchId, stepIndex: source.stepIndex },
    to: target,
  }], { maxMutations });
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

// Bass 根音软偏好：统一 0–4 音高枝中，低枝/根音权最高，向高枝渐降。
export function bassRootBranchWeights(branchCount, cfg = CONFIG, baseWeights = [], treeWeights = []) {
  const n = Math.max(0, Math.floor(Number(branchCount) || 0));
  if (!n) return [];
  return Array.from({ length: n }, (_, branchId) => {
    const base = clamp(Number(baseWeights[branchId] ?? 1), 0, 1);
    const rootBias = 1 - 0.65 * (branchId / Math.max(1, n - 1));
    const treeBias = clamp(Number(treeWeights[branchId] ?? rootBias), 0, 1);
    return clamp(0.08 + 0.92 * (0.2 * base + 0.3 * rootBias + 0.5 * treeBias), 0, 1);
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

  // 规则 C–E 先收集建议，末尾每个执行维只解析一次，避免按代码顺序叠加到边界。
  const suggestions = [];
  const suggest = (dimension, delta, priority, reason) => suggestions.push({
    dimension, delta, priority, reason,
  });
  const densityTier = dayStats.densityTier;
  if (dayStats.silentRatio > cfg.silentRaiseThreshold) {
    suggest('density', +1, 3, `全天沉默占比 ${dayStats.silentRatio.toFixed(2)}`);
  } else if (dayStats.switchRate > cfg.frenzyLowerThreshold) {
    suggest('density', -1, 3, `日换枝率 ${dayStats.switchRate.toFixed(1)} 过疯`);
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
  if (dwellTooShort) suggest('dwell', +1, 3, `驻留偏短（${meanDwellBeats.toFixed(1)}拍）`);
  else if (dwellTooLong) suggest('dwell', -1, 3, `驻留偏长（${meanDwellBeats.toFixed(1)}拍）`);

  // 闭环规则：economy 已完成偏好带比较，规则层只消费方向，避免复制评分公式。
  // 其它物种消费换枝偏离；Bass 的 Sequence 节奏消费有效起音步数偏离。
  // 偏低 → 缩短驻留/升密度；偏高 → 延长驻留并收窄活跃窗。
  const percussionSequence = cfg.species === 'texture' && cfg.percussionMode !== 'texture';
  const rhythmMetric = cfg.species === 'bass' || percussionSequence ? 'onsetCount' : 'branchChanges';
  const branchDeviation = ecology?.deviation?.[rhythmMetric];
  const branchDirection = typeof branchDeviation === 'string'
    ? branchDeviation : branchDeviation?.direction;
  const fullActiveBars = Math.max(MIN_AUDIBLE_ACTIVE_BARS,
    Math.round(Number(cfg.barsPerDay) || 4));
  const activeBarsBase = Number.isFinite(dayStats.activeBars)
    ? clamp(Math.round(dayStats.activeBars), MIN_AUDIBLE_ACTIVE_BARS, fullActiveBars)
    : fullActiveBars;
  if (branchDirection === 'low') {
    if (!dwellTooShort && cfg.dwellBase * (dwellBaseline - cfg.dwellBaselineStep) >= bandLo) {
      suggest('dwell', -1, 2, `${rhythmMetric === 'onsetCount' ? '起音' : '换枝'}偏低`);
    } else suggest('density', +1, 2, `${rhythmMetric === 'onsetCount' ? '起音' : '换枝'}偏低`);
  } else if (branchDirection === 'high') {
    if (!dwellTooLong) suggest('dwell', +1, 2, `${rhythmMetric === 'onsetCount' ? '起音' : '换枝'}偏高`);
    const silentHigh = dayStats.silentRatio > cfg.silentRaiseThreshold;
    if (!silentHigh) suggest('activeBars', -1, 2,
      `${rhythmMetric === 'onsetCount' ? '起音' : '换枝'}偏高`);
  }

  // Track B：跨声部错峰缺口 → 密度/驻留/活跃窗偏置（涌现式，不写死声部角色）。
  // 减弱执行交给 world.setVocalizeBias(0..1 梯度)；这里不改 densityTier，
  // 避免 sparse 粘住后 hold 日无法回满、把合奏长期掐哑。
  const crossDeviation = ecology?.deviation?.crossVoice;
  const crossDirection = typeof crossDeviation === 'string'
    ? crossDeviation : crossDeviation?.direction;
  const crossHint = ecology?.crossVoiceHint;
  if (crossDirection === 'low' && crossHint === 'suppress') {
    if (!dwellTooLong) suggest('dwell', +1, 1, '错峰偏低·抑制');
    suggest('activeBars', -1, 1, '错峰偏低·抑制');
  } else if (crossDirection === 'low' && crossHint === 'encourage') {
    suggest('density', +1, 1, '错峰偏低·填充');
    if (!dwellTooShort) suggest('dwell', -1, 1, '错峰偏低·填充');
  }

  // 生存循环：Master 只能从固定菜单选择；这里重新规范化并忽略外部 delta。
  // 当前菜单不直接改写任何音乐维度；策略只在 ledger 与 latent controller 生效，
  // 避免生存状态把原本通过音乐闸门的 Sequence 拉坏。
  const survivalAction = normalizeSurvivalAction(ecology?.survivalAction, ecology?.survival);
  for (const row of survivalAction?.suggestions ?? []) {
    suggest(row.dimension, row.delta, 0.5, row.reason);
  }

  // activeBars 是跨日持久状态，必须同时存在收窄与恢复路径。若今天没有任何
  // 收窄证据，就以最低优先级每次回补一小节；一旦 branch/crossVoice 仍要求
  // suppress，高优先级负建议会覆盖本恢复项，不会当天来回打架。
  if (activeBarsBase < fullActiveBars
    && !suggestions.some((row) => row.dimension === 'activeBars' && row.delta < 0)) {
    suggest('activeBars', +1, 0, '无收窄证据·缓慢回满');
  }

  const resolved = resolveBehaviorSuggestions(suggestions);
  const survivalApplied = (survivalAction?.suggestions ?? []).filter((row) => (
    resolved[row.dimension]?.reasons?.includes(row.reason)
  )).map((row) => row.dimension);
  const nextDensityTier = resolved.density
    ? tierStep(densityTier, resolved.density.delta) : densityTier;
  if (nextDensityTier !== densityTier) reasons.push(
    `密度:${densityTier}→${nextDensityTier}（${resolved.density.reasons.join('、')}）`,
  );
  if (resolved.dwell) {
    const before = dwellBaseline;
    dwellBaseline = clamp(dwellBaseline + resolved.dwell.delta * cfg.dwellBaselineStep,
      cfg.dwellBaselineMin, cfg.dwellBaselineMax);
    if (dwellBaseline !== before) reasons.push(
      `驻留基线:${before.toFixed(2)}→${dwellBaseline.toFixed(2)}（${resolved.dwell.reasons.join('、')}）`,
    );
  }
  const activeBars = resolved.activeBars
    ? clamp(activeBarsBase + resolved.activeBars.delta * ACTIVE_BARS_STEP,
      MIN_AUDIBLE_ACTIVE_BARS, fullActiveBars)
    : activeBarsBase;
  if (activeBars !== activeBarsBase) reasons.push(
    `活跃窗:${activeBarsBase}→${activeBars} 小节（${resolved.activeBars.reasons.join('、')}）`,
  );

  if (!reasons.length) reasons.push('保持：今日 pattern 均衡，明日原样循环');
  return {
    mutations,
    densityTier: nextDensityTier,
    dwellBaseline,
    activeBars,
    survivalActionId: survivalAction?.id ?? null,
    survivalApplied,
    reason: reasons.join('；'),
  };
}

// LLM flock 计划 → 内部 plan 形状（契约 {dwellBeats, activeBars, holdLoops, mutations[]}，
// 与 llm/integration.js 的 mapFlockPlan 对齐）。mutations 无 birdId，映射到家枝在该枝的鸟。
export function planFromLlm(llmPlan, assignments, stats, cfg = CONFIG.agent, sequencePattern = null) {
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
  const cellResult = applySequenceCellMutations(
    sequencePattern,
    decision.cellMutations ?? [],
    { maxMutations: cfg.maxMutationsPerDay },
  );
  if (sequencePattern && !cellResult) return null;
  if (!sequencePattern && (decision.cellMutations?.length ?? 0) > 0) return null;
  return {
    mutations,
    droppedMutations,
    cellMutations: cellResult?.mutations ?? [],
    sequencePattern: cellResult?.summary ?? sequencePattern,
    previousSequencePattern: sequencePattern,
    densityTier: stats.densityTier,
    dwellBeats: decision.dwellBeats,
    activeBars: decision.activeBars,
    holdLoops: decision.holdLoops,
    reason: `林群判断：驻留${decision.dwellBeats}拍 · 活跃${decision.activeBars}小节 · 保持${decision.holdLoops}循环`,
  };
}

// master 菜单：每季一条四和弦路径 + 日间色彩 id 列表。
// 字段同时保留 progressions/seasonPalettes 兼容形态（llm-master 与 policy.js 均消费）。
// 防音乐泄漏：progressions 兼容位用中性 id（季节名），和弦名/F 系音名不进菜单。
export function masterMenuFromConfig(cfg = CONFIG) {
  const { seasons, bySeason } = cfg.harmony;
  return {
    seasons: [...seasons],
    progressions: seasons.map((s) => [s]), // 旧外部适配器兼容；UI 不再暴露年度排序
    progressionsBySeason: Object.fromEntries(seasons.map((season) => [season,
      (bySeason[season]?.progressions ?? []).map((progression) => progression.id)])),
    seasonPalettes: Object.fromEntries(seasons.map((s) => [s,
      colorOptions(s, cfg.harmony, 0, 'day').map((c) => c.id)])),
    seasonLengthRange: cfg.llm.seasonLengthRange,
    tensionRange: [...(cfg.harmony.tensionRange ?? [0, 1])],
    cooldownDays: cfg.llm.masterCooldownDays,
  };
}

const CONDUCTOR_STATE_KEYS = ['conductor', 'sequence', 'control'];
const CONDUCTOR_KEYS = [
  'cursor',
  'treeScoreHistory',
  'harmonyScoreHistory',
  'pendingNext',
  'currentFrame',
  'currentChord',
  'pendingPlan',
  'pendingSource',
  'pendingReviewedDay',
  'duskColorShiftPlanned',
  'patternHistory',
  'holdState',
  'hCounts',
  'hPerchStart',
];
const CURSOR_KEYS = [
  'seasonIdx',
  'seasonDay',
  'seasonLength',
  'daysSinceChange',
  'currentColorId',
  'daysInColor',
  'progressionId',
  'lastDuskShiftDay',
  'lastDuskShiftCycle',
];
const SEQUENCE_STATE_KEYS = [
  'bridgeCurrent',
  'bridgePrevious',
  'reviewedPattern',
  'plannedPatterns',
];
const CONTROL_STATE_KEYS = ['masterControl', 'pendingUserSeasonLength'];
const PENDING_NEXT_KEYS = ['seasonIdx', 'seasonLength', 'progressionId'];
const FRAME_KEYS = [
  'season',
  'seasonDay',
  'seasonLength',
  'progressionStep',
  'progressionCycle',
  'progressionId',
  'period',
  'skeleton',
  'color',
  'tension',
];
const SKELETON_KEYS = ['id', 'root', 'notes'];
const COLOR_KEYS = ['id', 'notes'];
const CHORD_KEYS = [
  'id',
  'notes',
  'melodyNotes',
  'speciesMenus',
  'season',
  'seasonName',
  'skeletonBranches',
  'tension',
  'period',
  'progressionStep',
];
const HOLD_KEYS = ['counter', 'loops', 'generation', 'pitchDirection'];
const H_COUNT_KEYS = ['skeleton', 'color', 'outside'];
const H_PERCH_KEYS = ['birdId', 'treeId', 'key', 'start'];
const SUMMARY_KEYS = ['version', 'pitchBranchCount', 'stepCount', 'occupiedCells'];
const SUMMARY_CELL_KEYS = ['pitchBranchId', 'stepIndex', 'count'];

function deterministicConductorStateError() {
  const error = new Error('INVALID_DETERMINISTIC_CONDUCTOR_STATE');
  error.code = 'INVALID_DETERMINISTIC_CONDUCTOR_STATE';
  return error;
}

function nondeterministicSourceError() {
  const error = new Error('CHECKPOINT_NONDETERMINISTIC_SOURCE_ACTIVE');
  error.code = 'CHECKPOINT_NONDETERMINISTIC_SOURCE_ACTIVE';
  return error;
}

function unsupportedConfigurationError() {
  const error = new Error('CHECKPOINT_UNSUPPORTED_CONFIGURATION');
  error.code = 'CHECKPOINT_UNSUPPORTED_CONFIGURATION';
  return error;
}

function disposedConductorError() {
  const error = new Error('CHECKPOINT_CONDUCTOR_DISPOSED');
  error.code = 'CHECKPOINT_CONDUCTOR_DISPOSED';
  return error;
}

const LIFECYCLE_ABORT = Symbol('DETERMINISTIC_CONDUCTOR_LIFECYCLE_ABORT');

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string')
    || !keys.every((key) => Object.hasOwn(value, key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}

function cloneStrictJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw deterministicConductorStateError();
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw deterministicConductorStateError();
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      'length',
    ];
    const ownKeys = Reflect.ownKeys(value);
    if (Object.getPrototypeOf(value) !== Array.prototype
      || ownKeys.length !== expectedKeys.length
      || !expectedKeys.every((key) => ownKeys.includes(key))) {
      throw deterministicConductorStateError();
    }
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw deterministicConductorStateError();
      }
      return cloneStrictJson(descriptor.value, seen);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw deterministicConductorStateError();
  }
  const cloned = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw deterministicConductorStateError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw deterministicConductorStateError();
      }
      cloned[key] = cloneStrictJson(descriptor.value, seen);
  }
  return cloned;
}

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => jsonEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonEqual(left[key], right[key]));
}

const safeNonNegativeInteger = (value) => (
  Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
);
const safePositiveInteger = (value) => safeNonNegativeInteger(value) && value > 0;
const finiteInRange = (value, lo, hi) => (
  Number.isFinite(value) && !Object.is(value, -0) && value >= lo && value <= hi
);

function exactTreeMap(value, config, predicate) {
  const treeIds = config.trees.map((tree) => tree.id);
  return exactKeys(value, treeIds)
    && config.trees.every((tree) => predicate(value[tree.id], tree));
}

function validateSummary(summary, config, nullable = false, treeConfig = null) {
  if (nullable && summary === null) return true;
  const stepCount = config.tempo.barsPerDay * config.tempo.beatsPerBar;
  if (!exactKeys(summary, SUMMARY_KEYS)
    || summary.version !== 2
    || summary.pitchBranchCount !== config.tree.branches.length
    || summary.stepCount !== stepCount
    || !Array.isArray(summary.occupiedCells)) return false;
  const seen = new Set();
  return summary.occupiedCells.every((cell) => {
    if (!exactKeys(cell, SUMMARY_CELL_KEYS)
      || !safeNonNegativeInteger(cell.pitchBranchId)
      || cell.pitchBranchId >= summary.pitchBranchCount
      || !safeNonNegativeInteger(cell.stepIndex)
      || cell.stepIndex >= summary.stepCount
      || !safePositiveInteger(cell.count)
      || (treeConfig && cell.count > treeConfig.birdCount)) return false;
    const key = `${cell.pitchBranchId}:${cell.stepIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateFrameAndChord(conductor, config) {
  const { cursor, currentFrame: frame, currentChord: chord } = conductor;
  const season = config.harmony.seasons[cursor.seasonIdx];
  const [minimumTension, maximumTension] = config.harmony.tensionRange ?? [0, 1];
  if (!exactKeys(frame, FRAME_KEYS)
    || frame.season !== season
    || frame.seasonDay !== cursor.seasonDay
    || frame.seasonLength !== cursor.seasonLength
    || frame.progressionStep !== cursor.seasonDay % 4
    || frame.progressionCycle !== Math.floor(cursor.seasonDay / 4)
    || frame.progressionId !== cursor.progressionId
    || !['day', 'night'].includes(frame.period)
    || !exactKeys(frame.skeleton, SKELETON_KEYS)
    || !exactKeys(frame.color, COLOR_KEYS)
    || !finiteInRange(frame.tension, minimumTension, maximumTension)
    || !jsonEqual(
      frame.skeleton,
      skeletonForSeason(season, config.harmony, cursor.seasonDay, cursor.progressionId),
    )
    || !(colorOptions(
      season,
      config.harmony,
      cursor.seasonDay,
      frame.period,
      cursor.progressionId,
    ).some((color) => jsonEqual(color, frame.color)))
    || !exactKeys(chord, CHORD_KEYS)
    || !jsonEqual(chord, chordFromFrame(frame, config.harmony))) return false;
  return true;
}

function validateFrameColorState(conductor, config) {
  const { cursor, currentFrame: frame } = conductor;
  if (frame.period === 'day') {
    return cursor.currentColorId === frame.color.id;
  }
  if (frame.period !== 'night'
    || conductor.duskColorShiftPlanned !== false
    || cursor.lastDuskShiftDay === null
    || cursor.lastDuskShiftCycle !== Math.floor(cursor.seasonDay / 4)) {
    return false;
  }
  const dayColors = colorOptions(
    frame.season,
    config.harmony,
    cursor.seasonDay,
    'day',
    cursor.progressionId,
  );
  const dayColorIndex = dayColors.findIndex(
    (color) => color.id === cursor.currentColorId,
  );
  if (dayColorIndex < 0 || dayColors.length === 0) return false;
  const nightColors = colorOptions(
    frame.season,
    config.harmony,
    cursor.seasonDay,
    'night',
    cursor.progressionId,
  );
  return jsonEqual(
    frame.color,
    nightColors[(dayColorIndex + 1) % dayColors.length],
  );
}

function validateRestoredConductorState(restoredState, config) {
  const state = cloneStrictJson(restoredState);
  if (!exactKeys(state, CONDUCTOR_STATE_KEYS)
    || !exactKeys(state.conductor, CONDUCTOR_KEYS)
    || !exactKeys(state.sequence, SEQUENCE_STATE_KEYS)
    || !exactKeys(state.control, CONTROL_STATE_KEYS)) throw deterministicConductorStateError();
  const { conductor, sequence, control } = state;
  const { cursor } = conductor;
  const [seasonLengthLo, seasonLengthHi] = config.llm.seasonLengthRange;
  const validRuntimeSeasonLength = (value) => (
    safePositiveInteger(value)
    && (
      value === config.harmony.defaultSeasonLength
      || (value >= seasonLengthLo && value <= seasonLengthHi)
    )
  );
  if (!exactKeys(cursor, CURSOR_KEYS)
    || !safeNonNegativeInteger(cursor.seasonIdx)
    || cursor.seasonIdx >= config.harmony.seasons.length
    || !safeNonNegativeInteger(cursor.seasonDay)
    || !validRuntimeSeasonLength(cursor.seasonLength)
    || cursor.seasonDay >= cursor.seasonLength
    || !safeNonNegativeInteger(cursor.daysSinceChange)
    || typeof cursor.currentColorId !== 'string'
    || !cursor.currentColorId
    || !safePositiveInteger(cursor.daysInColor)
    || typeof cursor.progressionId !== 'string'
    || !(cursor.lastDuskShiftDay === null
      || safeNonNegativeInteger(cursor.lastDuskShiftDay))
    || !Number.isSafeInteger(cursor.lastDuskShiftCycle)
    || Object.is(cursor.lastDuskShiftCycle, -0)
    || cursor.lastDuskShiftCycle < -1
    || !(
      (cursor.lastDuskShiftDay === null && cursor.lastDuskShiftCycle === -1)
      || (
        safeNonNegativeInteger(cursor.lastDuskShiftDay)
        && safeNonNegativeInteger(cursor.lastDuskShiftCycle)
      )
    )) throw deterministicConductorStateError();
  const season = config.harmony.seasons[cursor.seasonIdx];
  if (!(config.harmony.bySeason[season]?.progressions ?? [])
    .some((progression) => progression.id === cursor.progressionId)) {
    throw deterministicConductorStateError();
  }
  const validateHistory = (nullable) => (history) => (
    Array.isArray(history)
    && history.length <= 3
    && history.every((score) => (
      (nullable && score === null) || finiteInRange(score, 0, 1)
    ))
  );
  if (!exactTreeMap(conductor.treeScoreHistory, config, validateHistory(false))
    || !exactTreeMap(conductor.harmonyScoreHistory, config, validateHistory(true))) {
    throw deterministicConductorStateError();
  }
  if (!(conductor.pendingNext === null || (
    exactKeys(conductor.pendingNext, PENDING_NEXT_KEYS)
    && safeNonNegativeInteger(conductor.pendingNext.seasonIdx)
    && conductor.pendingNext.seasonIdx < config.harmony.seasons.length
    && validRuntimeSeasonLength(conductor.pendingNext.seasonLength)
    && typeof conductor.pendingNext.progressionId === 'string'
    && (config.harmony.bySeason[
      config.harmony.seasons[conductor.pendingNext.seasonIdx]
    ]?.progressions ?? []).some(
      (progression) => progression.id === conductor.pendingNext.progressionId,
    )
  ))) throw deterministicConductorStateError();
  if (!validateFrameAndChord(conductor, config)
    || !validateFrameColorState(conductor, config)
    || conductor.pendingPlan !== null
    || conductor.pendingSource !== null
    || conductor.pendingReviewedDay !== null
    || typeof conductor.duskColorShiftPlanned !== 'boolean'
    || !Array.isArray(conductor.patternHistory)
    || !conductor.patternHistory.every((pattern) => (
      exactTreeMap(pattern, config, (summary, tree) => (
        validateSummary(summary, config, false, tree)
      ))
    ))
    || !exactTreeMap(conductor.holdState, config, (hold) => (
      exactKeys(hold, HOLD_KEYS)
      && safeNonNegativeInteger(hold.counter)
      && safePositiveInteger(hold.loops)
      && hold.loops >= config.agent.holdLoopsRange[0]
      && hold.loops <= config.agent.holdLoopsRange[1]
      && hold.counter <= hold.loops
      && safeNonNegativeInteger(hold.generation)
      && (hold.pitchDirection === -1 || hold.pitchDirection === 1)
    ))
    || !exactTreeMap(conductor.hCounts, config, (counts) => (
      exactKeys(counts, H_COUNT_KEYS)
      && Object.values(counts).every((value) => Number.isFinite(value) && value >= 0)
    ))
    || !Array.isArray(conductor.hPerchStart)) throw deterministicConductorStateError();
  const seenPerched = new Set();
  for (const record of conductor.hPerchStart) {
    if (!exactKeys(record, H_PERCH_KEYS)
      || !safeNonNegativeInteger(record.birdId)
      || seenPerched.has(record.birdId)
      || !config.trees.some((tree) => tree.id === record.treeId)
      || !['skeleton', 'color', 'outside'].includes(record.key)
      || !Number.isFinite(record.start)
      || record.start < 0) throw deterministicConductorStateError();
    seenPerched.add(record.birdId);
  }
  if (!exactTreeMap(sequence.plannedPatterns, config, (summary, tree) => (
    validateSummary(summary, config, true, tree)
  ))
    || !(sequence.reviewedPattern === null
      || (sequence.reviewedPattern && typeof sequence.reviewedPattern === 'object'))
    || ((sequence.bridgePrevious === null) !== (sequence.reviewedPattern === null))
    || (sequence.bridgePrevious !== null
      && !jsonEqual(sequence.bridgePrevious, sequence.reviewedPattern))
    || ((sequence.bridgePrevious === null) !== (conductor.patternHistory.length === 0))) {
    throw deterministicConductorStateError();
  }
  if (sequence.reviewedPattern !== null) {
    const lastPattern = conductor.patternHistory[conductor.patternHistory.length - 1];
    const summarized = Object.fromEntries(config.trees.map((tree) => [
      tree.id,
      sequencePatternSummary(sequence.reviewedPattern, tree.id),
    ]));
    if (!jsonEqual(lastPattern, summarized)) throw deterministicConductorStateError();
  }
  if (!['AGENT', 'USER'].includes(control.masterControl)
    || !(control.pendingUserSeasonLength === null
      || (safePositiveInteger(control.pendingUserSeasonLength)
        && control.pendingUserSeasonLength >= seasonLengthLo
        && control.pendingUserSeasonLength <= seasonLengthHi))) {
    throw deterministicConductorStateError();
  }
  return state;
}

function readReviewSource(source) {
  if (source === null) return null;
  const keysByKind = {
    'pipeline-v1': ['kind', 'pipeline'],
    'evaluator-v1': ['kind', 'evaluator'],
    'combined-v1': ['kind', 'pipeline', 'evaluator'],
  };
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.getPrototypeOf(source) !== Object.prototype) {
    throw new TypeError('INVALID_CONDUCTOR_REVIEW_SOURCE');
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(source, 'kind');
  const kind = kindDescriptor && 'value' in kindDescriptor ? kindDescriptor.value : null;
  const keys = keysByKind[kind];
  if (!keys || !exactKeys(source, keys)) throw new TypeError('INVALID_CONDUCTOR_REVIEW_SOURCE');
  const pipeline = kind === 'evaluator-v1' ? null : source.pipeline;
  const evaluator = kind === 'pipeline-v1' ? null : source.evaluator;
  if (kind !== 'evaluator-v1' && (
    !pipeline
    || typeof pipeline.dayReview !== 'function'
    || typeof pipeline.dawnPlan !== 'function'
  )) throw new TypeError('INVALID_CONDUCTOR_REVIEW_SOURCE');
  if (kind !== 'pipeline-v1' && typeof evaluator !== 'function') {
    throw new TypeError('INVALID_CONDUCTOR_REVIEW_SOURCE');
  }
  return source;
}

// 评估流水线接线（双树版）。
// pipeline：createAgentPipeline 产物（{dayReview, dawnPlan}），可为 null（纯规则）。
// evaluator：遗留测试钩子（async (stats, ctx) => plan），提供时优先于 pipeline 的 flock 通道。
// 回调：onPlan / onApply / onChord / onMaster（均带决策来源标签）。
// holdLoops（§3.5.3.3）：melody 带内冻结、生态偏离时允许一项小变；期满小变
// （≤holdMutationMax、邻枝优先、禁整句重掷、保证真改枝）。
export function createDeterministicConductor(world, {
  config = CONFIG,
  rng = Math.random,
  restoredState = null,
  reviewSource = null,
  onPlan = null,
  onApply = null,
  onChord = null,
  onMaster = null,
  onTempoIntent = null,
  // 生态计分注入口（economy 接线）：(treeId) => {branchChangesPerLoop,
  // sequenceOnsetCount, intervalRegularity, meanDwellBeats, clusterSize,
  // clusterPeak, score, deviation} | null。缺省不注入，LLM prompt 侧按可选字段处理。
  ecologyProvider = null,
  getPercussionMode = null,
  sequenceEnabled = true,
} = {}) {
  const restored = restoredState === null
    ? null
    : validateRestoredConductorState(restoredState, config);
  const validatedReviewSource = readReviewSource(reviewSource);
  if (!(ecologyProvider === null || typeof ecologyProvider === 'function')
    || !(getPercussionMode === null || typeof getPercussionMode === 'function')
    || ![onPlan, onApply, onChord, onMaster, onTempoIntent]
      .every((callback) => callback === null || typeof callback === 'function')
    || typeof sequenceEnabled !== 'boolean') {
    throw new TypeError('INVALID_DETERMINISTIC_CONDUCTOR_OPTIONS');
  }
  const masterMenu = masterMenuFromConfig(config);
  let reviewSourceRef = validatedReviewSource;
  let pipelineRef = reviewSourceRef?.kind === 'pipeline-v1'
    || reviewSourceRef?.kind === 'combined-v1'
    ? reviewSourceRef.pipeline : null;
  let evaluator = reviewSourceRef?.kind === 'evaluator-v1'
    || reviewSourceRef?.kind === 'combined-v1'
    ? reviewSourceRef.evaluator : null;
  let sourceGeneration = 0;
  let lifecycleGeneration = 0;
  let disposed = false;
  const unsubscribers = [];
  const lifecycleIsActive = (generation) => (
    !disposed && generation === lifecycleGeneration
  );
  const assertLifecycle = (generation) => {
    if (!lifecycleIsActive(generation)) throw LIFECYCLE_ABORT;
  };
  const callLifecycleBoundary = (generation, callback) => {
    const result = callback();
    assertLifecycle(generation);
    return result;
  };
  const rngForLifecycle = (generation) => (
    generation === null ? rng : () => callLifecycleBoundary(generation, rng)
  );
  // 季游标：seasonDay 0-based；生产 seasonLength 固定为 8。
  // master 在季末日的 nextSeason/seasonLength 存为换季预告，次日黎明生效。
  // daysSinceChange 初值=2：避开「开局伪冷却」——仅真实换季才归零进入 SEASON_COOLDOWN_DAYS。
  // currentColorId/daysInColor：决策应用后回填，供次日 master 三观（腻值/换档基准）。
  const SCORE_HISTORY_DAYS = 3; // policy trailingLow 连续低分至少要 2 天历史
  const cursor = restored?.conductor.cursor ?? {
    seasonIdx: 0,
    seasonDay: 0,
    seasonLength: config.harmony.defaultSeasonLength,
    daysSinceChange: 2,
    currentColorId: null,
    daysInColor: 0,
    progressionId: config.harmony.bySeason[config.harmony.seasons[0]]?.progressions?.[0]?.id ?? null,
    lastDuskShiftDay: -Infinity,
    lastDuskShiftCycle: -1,
  };
  if (cursor.lastDuskShiftDay === null) cursor.lastDuskShiftDay = -Infinity;
  // 每树 score 短历史（滚动 2–3 天）：policy 读数组尾部 streak，标量永远 streak≤1。
  const treeScoreHistory = restored?.conductor.treeScoreHistory
    ?? Object.fromEntries(config.trees.map((t) => [t.id, []]));
  const harmonyScoreHistory = restored?.conductor.harmonyScoreHistory
    ?? Object.fromEntries(config.trees.map((t) => [t.id, []]));
  let pendingNext = restored?.conductor.pendingNext ?? null;
  let currentFrame = restored?.conductor.currentFrame ?? null;
  let currentChord = restored?.conductor.currentChord ?? null;
  let pendingPlan = restored?.conductor.pendingPlan ?? null;
  let pendingSource = restored?.conductor.pendingSource ?? null;
  let pendingReviewedDay = restored?.conductor.pendingReviewedDay ?? null;
  let masterControl = restored?.control.masterControl ?? 'AGENT';
  let duskColorShiftPlanned = restored?.conductor.duskColorShiftPlanned ?? false;
  let pendingUserSeasonLength = restored?.control.pendingUserSeasonLength ?? null;
  const patternHistory = restored?.conductor.patternHistory ?? [];
  // Sequence v2 迁移桥：只镜像实际 perch 起音，不回写 world。
  const sequenceBridge = createSequencePatternBridge({
    config,
    restoredState: restored === null ? null : {
      current: restored.sequence.bridgeCurrent,
      previous: restored.sequence.bridgePrevious,
    },
  });
  let reviewedSequencePattern = restored?.sequence.reviewedPattern ?? null;
  const plannedSequencePatterns = restored?.sequence.plannedPatterns
    ?? Object.fromEntries(config.trees.map((tree) => [tree.id, null]));
  function handleSequencePerch(event) {
    sequenceBridge.feed({ type: 'perch', ...event });
  }
  // 乐句保持期状态（按树）：generation 让每次期满选择不同 cell/轴，避免两格摆动。
  const holdState = restored?.conductor.holdState
    ?? Object.fromEntries(config.trees.map((t) => [t.id, {
    counter: 0,
    loops: config.agent.defaultHoldLoops,
    generation: 0,
    pitchDirection: 1,
  }]));

  // ---- 和谐分 H（只观测不进分）：逐树逐日统计「发音落枝」的框架归属 ----
  // 按发音秒加权（持续在鸣也计入，否则长驻物种天天无观测）：骨架枝 1.0 / 色彩枝 0.7 /
  // 框架外 0；直接保留加权平均 H，全天无发音 → null。
  const hCounts = restored?.conductor.hCounts
    ?? Object.fromEntries(config.trees.map((t) => [t.id, { skeleton: 0, color: 0, outside: 0 }]));
  const hPerchStart = new Map((restored?.conductor.hPerchStart ?? []).map((record) => [
    record.birdId,
    {
      treeId: record.treeId,
      key: record.key,
      start: record.start,
    },
  ]));
  const classOfBranch = (branchId) => {
    if (!Number.isInteger(branchId) || branchId < 0 || branchId >= config.tree.branches.length) return 'outside';
    return branchId < config.harmony.skeletonBranches ? 'skeleton' : 'color';
  };
  function handleHarmonyPerch(event, lifecycle) {
    if (!hCounts[event.treeId]) return;
    const tree = config.trees.find((entry) => entry.id === event.treeId);
    const percussionMode = tree?.species === 'texture'
      ? callLifecycleBoundary(lifecycle, () => getPercussionMode?.() ?? 'jungle')
      : null;
    if (tree?.species === 'texture' && percussionMode !== 'texture') return;
    const now = callLifecycleBoundary(lifecycle, () => world.getSnapshot().simTime);
    hPerchStart.set(event.birdId, {
      treeId: event.treeId, key: classOfBranch(event.branchId), start: now,
    });
  }
  function handleHarmonyUnperch(event, lifecycle) {
    const rec = hPerchStart.get(event.birdId);
    if (!rec) return;
    hPerchStart.delete(event.birdId);
    const seconds = Number.isFinite(event.dwellTime)
      ? event.dwellTime
      : Math.max(
        0,
        callLifecycleBoundary(lifecycle, () => world.getSnapshot().simTime) - rec.start,
      );
    hCounts[rec.treeId][rec.key] += Math.max(0, seconds);
  }
  // 读取时把在鸣鸟的已鸣时长临时并入（不改计数器；黎明结算时才真正入账）
  function harmonyScores(lifecycle = null) {
    const now = lifecycle === null
      ? world.getSnapshot().simTime
      : callLifecycleBoundary(lifecycle, () => world.getSnapshot().simTime);
    const ongoing = {};
    for (const rec of hPerchStart.values()) {
      ongoing[rec.treeId] ??= { skeleton: 0, color: 0, outside: 0 };
      ongoing[rec.treeId][rec.key] += Math.max(0, now - rec.start);
    }
    const w = config.harmony.harmonyWeights;
    return Object.fromEntries(Object.entries(hCounts).map(([treeId, c]) => {
      const merged = {
        skeleton: c.skeleton + (ongoing[treeId]?.skeleton ?? 0),
        color: c.color + (ongoing[treeId]?.color ?? 0),
        outside: c.outside + (ongoing[treeId]?.outside ?? 0),
      };
      return [treeId, {
        harmonyScore: harmonyScoreFromCounts(merged, w),
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
  function settleHarmonyCounts(lifecycle) {
    const now = callLifecycleBoundary(lifecycle, () => world.getSnapshot().simTime);
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
  // 张力按季节进度 tensionRange 下沿→上沿爬升）。
  function buildFrame(masterDecision, period = 'day', colorIndex = null) {
    const season = config.harmony.seasons[cursor.seasonIdx];
    const colors = colorOptions(season, config.harmony, cursor.seasonDay, period, cursor.progressionId);
    const color = colors.find((c) => c.id === masterDecision?.colorId)
      ?? colors[colorIndex ?? (cursor.seasonDay % Math.max(1, colors.length))];
    const span = Math.max(1, cursor.seasonLength - 1);
    const [tensionLo, tensionHi] = config.harmony.tensionRange ?? [0, 1];
    const tension = Number.isFinite(Number(masterDecision?.tension))
      ? clamp(Number(masterDecision.tension), tensionLo, tensionHi)
      : tensionLo + (tensionHi - tensionLo) * (cursor.seasonDay / span);
    return {
      season,
      seasonDay: cursor.seasonDay,
      seasonLength: cursor.seasonLength,
      progressionStep: cursor.seasonDay % 4,
      progressionCycle: Math.floor(cursor.seasonDay / 4),
      progressionId: cursor.progressionId,
      period,
      skeleton: skeletonForSeason(season, config.harmony, cursor.seasonDay, cursor.progressionId),
      color,
      tension,
    };
  }
  function setMasterControl(mode) {
    if (disposed) throw disposedConductorError();
    masterControl = mode === 'USER' ? 'USER' : 'AGENT';
    if (masterControl === 'AGENT') {
      pendingUserSeasonLength = null;
    }
    return masterControl;
  }
  function setUserSeasonLength(days) {
    if (disposed) throw disposedConductorError();
    const [lo, hi] = config.llm.seasonLengthRange;
    const next = Math.trunc(Number(days));
    if (!Number.isInteger(next)) return false;
    pendingUserSeasonLength = clamp(next, lo, hi);
    return true;
  }
  function applyUserColor(colorId) {
    if (disposed) throw disposedConductorError();
    const lifecycle = lifecycleGeneration;
    if (masterControl !== 'USER' || typeof colorId !== 'string') return false;
    const options = colorOptions(currentFrame.season, config.harmony, cursor.seasonDay, 'day', cursor.progressionId);
    if (!options.some((color) => color.id === colorId)) return false;
    const previous = currentChord;
    currentFrame = buildFrame({ colorId, tension: currentFrame.tension });
    currentChord = chordFromFrame(currentFrame, config.harmony);
    commitColorState(colorId);
    try {
      pushBranchPreferences(lifecycle);
      const masterDay = callLifecycleBoundary(
        lifecycle,
        () => world.getSnapshot().day,
      );
      callLifecycleBoundary(lifecycle, () => onMaster?.({
        day: masterDay,
        decision: { colorId, tension: currentFrame.tension, reason: 'Master USER 色彩' },
        source: 'USER', frame: currentFrame, chord: currentChord, seasonChanged: false,
      }));
      if (previous.id !== currentChord.id) {
        const chordDay = callLifecycleBoundary(
          lifecycle,
          () => world.getSnapshot().day,
        );
        callLifecycleBoundary(lifecycle, () => onChord?.({
          day: chordDay, prevChord: previous, nextChord: currentChord,
        }));
      }
    } catch (error) {
      if (error !== LIFECYCLE_ABORT) throw error;
    }
    return true;
  }
  // 张力→枝偏好接线（P0-B）：骨架/色彩语义只在 conductor 侧换算，world 只见 0..1 权重。
  function pushBranchPreferences(lifecycle = null) {
    const bias = config.harmony.tensionBranchBias;
    if (!bias) return;
    const k = config.harmony.skeletonBranches;
    const colorW = bias.colorWeightAt0
      + (bias.colorWeightAt1 - bias.colorWeightAt0) * clamp(currentFrame.tension, 0, 1);
    const weights = config.tree.branches.map((_, i) => (i < k ? bias.skeletonWeight : colorW));
    const snap = lifecycle === null
      ? world.getSnapshot()
      : callLifecycleBoundary(lifecycle, () => world.getSnapshot());
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
        // Bass 低枝/根音软偏好；权重长度对齐统一的 5 条音高枝。
        const padded = Array.from({ length: slotCount }, (_, i) => weights[i] ?? weights[weights.length - 1] ?? 1);
        treeWeights = bassRootBranchWeights(slotCount, config, padded, t.pitchBranchWeights);
      }
      if (lifecycle === null) {
        world.setBranchPreference?.(t.id, treeWeights);
      } else {
        callLifecycleBoundary(
          lifecycle,
          () => world.setBranchPreference?.(t.id, treeWeights),
        );
      }
    }
  }

  // Track B：跨声部错峰缺口 → 发声偏置（world 只收 0..1，不懂声部语义）。
  function pushVocalizeBiases(lifecycle) {
    if (typeof world.setVocalizeBias !== 'function') return;
    const cv = config.economy?.crossVoice ?? {};
    for (const t of config.trees) {
      const eco = ecologyFor(t.id, lifecycle);
      const hint = eco?.crossVoiceHint;
      let bias = Number(cv.holdBias ?? 1);
      if (hint === 'suppress') bias = Number(cv.suppressBias ?? 0);
      else if (hint === 'encourage') bias = Number(cv.encourageBias ?? 1);
      callLifecycleBoundary(lifecycle, () => world.setVocalizeBias(t.id, bias));
    }
  }

  if (restored === null) {
    currentFrame = buildFrame(null);
    currentChord = chordFromFrame(currentFrame, config.harmony);
    cursor.currentColorId = currentFrame.color.id;
    cursor.daysInColor = 1;
    pushBranchPreferences();
  }

  // 日终分数入账：在 masterInput 之前调用，保证 observations 含「含今日」的短历史数组。
  function pushScoreHistories(lifecycle) {
    const snap = callLifecycleBoundary(lifecycle, () => world.getSnapshot());
    const scores = harmonyScores(lifecycle);
    for (const t of snap.trees) {
      const eco = Number(ecologyFor(t.id, lifecycle)?.score);
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
  const rulePlan = (treeSnap, treeStats, lifecycle = null) => {
    const sp = config.species[treeSnap.species];
    const dwellPref = config.economy?.prefs?.[treeSnap.species]?.meanDwell;
    const ecology = ecologyFor(treeSnap.id, lifecycle);
    const readPercussionMode = () => (
      lifecycle === null
        ? (getPercussionMode?.() ?? config.audio?.timbres?.texture?.mode ?? 'jungle')
        : callLifecycleBoundary(
          lifecycle,
          () => getPercussionMode?.() ?? config.audio?.timbres?.texture?.mode ?? 'jungle',
        )
    );
    const guardedRng = rngForLifecycle(lifecycle);
    const base = evaluateDay(treeStats,
      treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch })),
      {
        ...config.agent,
        branchCount: config.tree.branches.length,
        dwellBase: sp.dwellBeats,
        dwellPref,
        barsPerDay: config.tempo.barsPerDay,
        species: treeSnap.species,
        percussionMode: treeSnap.species === 'texture' ? readPercussionMode() : null,
        seasonMigrationOnly: !!sp.seasonMigrationOnly,
        crossVoiceSevereConflict: config.economy?.crossVoice?.severeConflictRatio,
      },
      guardedRng,
      ecology);
    const [holdMin, holdMax] = config.agent.holdLoopsRange;
    const holdLoops = Math.round(holdMin + guardedRng() * (holdMax - holdMin)); // agent 范围内自选
    const previousSequencePattern = sequenceEnabled
      ? sequencePatternSummary(reviewedSequencePattern, treeSnap.id) : null;
    const sequence = sequenceEnabled ? ruleSequencePlan(previousSequencePattern, treeStats.day, {
      holdLoops: config.agent.defaultHoldLoops,
      maxMutations: config.agent.maxMutationsPerDay,
      preferJungleGrid: treeSnap.species === 'texture'
        && readPercussionMode() === 'jungle',
      onsetCountDirection: ecology?.deviation?.onsetCount?.direction,
      regularityDirection: ecology?.deviation?.intervalRegularity?.direction,
      roleDiversityDirection: ecology?.deviation?.roleDiversity?.direction,
      gridDriftBand: config.agent.gridDrift?.onsetBands?.[treeSnap.species],
      gridDriftMinSimilarity: config.agent.gridDrift?.minDaySimilarity,
      pitchBranchWeights: config.trees.find((tree) => tree.id === treeSnap.id)?.pitchBranchWeights,
    }) : null;
    const previousPatterns = patternHistory.slice(-2);
    const patternSimilarity = previousPatterns.length === 2
      ? meanTreePatternSimilarity(previousPatterns[0], previousPatterns[1]) : 0;
    const junglePlan = treeSnap.species === 'texture'
      && readPercussionMode() === 'jungle'
      ? jungleEditPlan({
        day: treeStats.day,
        tension: currentFrame?.tension ?? 0,
        onsetCount: previousSequencePattern?.occupiedCells?.length ?? 0,
        conflictRatio: ecology?.crossVoiceConflictRatio ?? 0,
        patternSimilarity,
      }) : null;
    // P1-1：计划 dwell 不得压出偏好带下限（bass/pad lo 有限、hi=∞ → clamp 到 [lo, ∞)）
    let dwellBeats = sp.dwellBeats * base.dwellBaseline;
    if (Number.isFinite(dwellPref?.lo)) dwellBeats = Math.max(dwellBeats, dwellPref.lo);
    return {
      mutations: base.mutations,
      densityTier: base.densityTier,
      dwellBeats,
      activeBars: base.activeBars,
      holdLoops,
      cellMutations: sequence?.mutations ?? [],
      sequencePattern: sequence?.summary ?? previousSequencePattern,
      previousSequencePattern,
      jungleEditPlan: junglePlan,
      reason: base.reason,
    };
  };

  function patternOf(grid) {
    return Object.fromEntries(config.trees.map((tree) => [
      tree.id,
      sequencePatternSummary(grid, tree.id),
    ]));
  }
  function ecologyFor(treeId, lifecycle = null) {
    try {
      const ecology = ecologyProvider?.(treeId) ?? null;
      if (lifecycle !== null) assertLifecycle(lifecycle);
      return ecology;
    } catch (error) {
      if (error === LIFECYCLE_ABORT) throw error;
      if (lifecycle !== null) assertLifecycle(lifecycle);
      return null;
    }
  }

  function masterInput(stats, lifecycle) {
    const snap = callLifecycleBoundary(lifecycle, () => world.getSnapshot());
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
        progressionId: cursor.progressionId,
        duskShiftAllowed: (stats.day - cursor.lastDuskShiftDay) >= 2
          && cursor.lastDuskShiftCycle !== Math.floor(cursor.seasonDay / 4),
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
      period: currentFrame.period,
      progressionStep: currentFrame.progressionStep,
      progressionCycle: currentFrame.progressionCycle,
    };
  }

  function flockInput(stats, lifecycle) {
    const snap = callLifecycleBoundary(lifecycle, () => world.getSnapshot());
    const scores = harmonyScores(lifecycle);
    // 生态投影四字段平铺根级（勿嵌 harmonicFrame）：client.normalizeEcologySnapshot
    // 白名单只读根级/flock 级 tension|skeletonBranchIds|colorBranchIds|colorId。
    return {
      day: stats.day,
      dayPhase: 'dawn',
      season: currentChord.season,
      ...frameProjection(),
      flocks: snap.trees.map((t) => {
        const ecology = ecologyFor(t.id, lifecycle);
        return {
          species: t.species,
          energy: t.meanEnergy,
          perchFlyRatio: t.birds.length ? t.perchedTotal / t.birds.length : 0,
          // 每只鸟当前家枝：mutations.from 只能取自该列表，否则 planFromLlm 整批丢弃。
          homeBranches: t.birds.map((b) => b.homeBranch),
          ...(reviewedSequencePattern
            ? { sequencePattern: sequencePatternSummary(reviewedSequencePattern, t.id) }
            : {}),
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
  async function runEvaluation(stats, lifecycle) {
    const generation = sourceGeneration;
    const evaluatorRef = evaluator;
    let plans = null;
    let source = null;
    if (evaluatorRef) {
      try {
        plans = await callLifecycleBoundary(
          lifecycle,
          () => evaluatorRef(
            stats,
            { season: currentFrame.season, colorId: currentFrame.color.id },
          ),
        );
        if (plans) source = 'LLM';
      } catch { /* 掉线回落规则层 */ }
    }
    if (!lifecycleIsActive(lifecycle) || generation !== sourceGeneration) return;
    if (!plans) {
      try {
        const snap = callLifecycleBoundary(lifecycle, () => world.getSnapshot());
        plans = Object.fromEntries(snap.trees.map(
          (t) => [t.id, rulePlan(t, stats.trees[t.id], lifecycle)],
        ));
      } catch (error) {
        if (error === LIFECYCLE_ABORT) return;
        throw error;
      }
      source = '规则层';
    }
    if (!lifecycleIsActive(lifecycle) || generation !== sourceGeneration) return;
    pendingPlan = plans;
    pendingSource = source;
    pendingReviewedDay = stats.day;
    onPlan?.({ plans, source, reviewedDay: stats.day, targetDay: stats.day + 2 });
  }

  // melody 保持期只在生态带内冻结家枝；偏离时允许一项小变自适应。
  // dwell/active/density 始终可随日评估更新。
  function applyHoldLoops(treeId, plan, lifecycle) {
    const tree = callLifecycleBoundary(
      lifecycle,
      () => world.getSnapshot().trees.find((t) => t.id === treeId),
    );
    const sp = tree?.species;
    if (config.species[sp]?.seasonMigrationOnly) {
      return { plan: { ...plan, mutations: [] }, held: true, seasonOnly: true };
    }
    if (sp !== 'melody') return { plan, held: false };
    const hold = holdState[treeId];
    if (hold.counter < hold.loops) {
      hold.counter += 1;
      const beforeOnsets = plan.previousSequencePattern?.occupiedCells?.length;
      const afterOnsets = plan.sequencePattern?.occupiedCells?.length;
      // hold 只冻结主题搬移，不得冻结偏好带的冷启动/密度修复；否则空 Melody
      // 网格会因为 additions 不是 cellMutations 而永远无法恢复。
      if (beforeOnsets === 0 && Number.isInteger(afterOnsets) && afterOnsets > 0) {
        return {
          plan: {
            ...plan,
            mutations: [],
            cellMutations: [],
            reason: `${plan.reason} · 保持期密度修复:${beforeOnsets}→${afterOnsets}`,
          },
          held: true,
          softened: true,
          gridDrift: true,
          holdLeft: hold.loops - hold.counter,
        };
      }
      const deviation = ecologyFor(treeId, lifecycle)?.deviation ?? {};
      const adaptiveEntry = ['branchChanges', 'meanDwell', 'cohortSize']
        .map((metric) => ({ metric, direction: typeof deviation[metric] === 'string'
          ? deviation[metric] : deviation[metric]?.direction }))
        .find(({ direction }) => direction === 'low' || direction === 'high');
      if (adaptiveEntry && (plan.mutations.length || plan.cellMutations?.length)) {
        const adjacent = plan.mutations.filter((m) => Math.abs(m.to - m.from) === 1);
        const rest = plan.mutations.filter((m) => Math.abs(m.to - m.from) !== 1);
        const mutations = [...adjacent, ...rest].slice(0, 1);
        const metricLabel = {
          branchChanges: '换枝', meanDwell: '驻留', cohortSize: '群聚',
        }[adaptiveEntry.metric] ?? adaptiveEntry.metric;
        const directionLabel = adaptiveEntry.direction === 'low' ? '偏低' : '偏高';
        const cellMutations = mutations.length ? [] : (plan.cellMutations ?? []).slice(0, 1);
        const cellResult = plan.previousSequencePattern
          ? applySequenceCellMutations(plan.previousSequencePattern, cellMutations, { maxMutations: 1 })
          : null;
        return {
          plan: {
            ...plan,
            mutations,
            cellMutations: cellResult?.mutations ?? [],
            sequencePattern: cellResult?.summary ?? plan.previousSequencePattern ?? plan.sequencePattern,
            reason: `${plan.reason} · 保持期软适应:${metricLabel}${directionLabel}`,
          },
          held: true,
          softened: true,
          holdLeft: hold.loops - hold.counter,
        };
      }
      return {
        plan: {
          ...plan,
          mutations: [],
          cellMutations: [],
          sequencePattern: plan.previousSequencePattern ?? plan.sequencePattern,
        },
        held: true,
        holdLeft: hold.loops - hold.counter,
      };
    }
    // 期满小变：邻枝优先、上限收紧、禁整句重掷
    const adjacent = plan.mutations.filter((m) => Math.abs(m.to - m.from) === 1);
    const rest = plan.mutations.filter((m) => Math.abs(m.to - m.from) !== 1);
    let picked = [...adjacent, ...rest].slice(0, config.agent.holdMutationMax);
    picked = ensurePatternMutation(
      picked,
      tree?.birds ?? [],
      config.tree.branches.length,
      rngForLifecycle(lifecycle),
    )
      .slice(0, config.agent.holdMutationMax);
    const [holdMin, holdMax] = config.agent.holdLoopsRange;
    hold.loops = Number.isInteger(plan.holdLoops)
      ? clamp(plan.holdLoops, holdMin, holdMax)
      : config.agent.defaultHoldLoops;
    // 变异发生的本轮不计入新保持期；下一轮才是 H 个完整 suppress 循环中的第 1 轮。
    hold.counter = 0;
    hold.generation += 1;
    // 随机 hold 到期日可能永远与 ruleSequencePlan 的固定 period 错相，造成 Melody
    // 网格永久冻结。到期而本轮无 cell 小变时，强制一次同契约原子移动；主题仍
    // 保持 H 日，但每个完整保持周期后必有可听变化。
    let cellMutations = plan.cellMutations ?? [];
    let sequencePattern = plan.sequencePattern;
    if (!cellMutations.length && !(plan.additions?.length) && !(plan.removals?.length)
      && plan.previousSequencePattern && hold.generation >= 4) {
      const summary = plan.previousSequencePattern;
      const cells = summary.occupiedCells ?? [];
      const source = cells[(hold.generation - 1) % Math.max(1, cells.length)];
      const occupied = new Set(cells.map((cell) => `${cell.pitchBranchId}:${cell.stepIndex}`));
      let target = source ? {
        pitchBranchId: source.pitchBranchId + hold.pitchDirection,
        stepIndex: source.stepIndex,
      } : null;
      if (target && (target.pitchBranchId < 0 || target.pitchBranchId >= summary.pitchBranchCount
        || occupied.has(`${target.pitchBranchId}:${target.stepIndex}`))) {
        hold.pitchDirection *= -1;
        target = {
          pitchBranchId: source.pitchBranchId + hold.pitchDirection,
          stepIndex: source.stepIndex,
        };
      }
      if (target && (target.pitchBranchId < 0 || target.pitchBranchId >= summary.pitchBranchCount
        || occupied.has(`${target.pitchBranchId}:${target.stepIndex}`))) target = null;
      const forced = source && target
        ? applySequenceCellMutations(summary, [{
          from: { pitchBranchId: source.pitchBranchId, stepIndex: source.stepIndex },
          to: target,
        }], { maxMutations: 1 })
        : ruleSequencePlan(summary, 1, {
          holdLoops: 1,
          maxMutations: 1,
          gridDriftBand: config.agent.gridDrift?.onsetBands?.melody,
          gridDriftMinSimilarity: config.agent.gridDrift?.minDaySimilarity,
        });
      cellMutations = forced?.mutations ?? [];
      sequencePattern = forced?.summary ?? sequencePattern;
    }
    return {
      plan: { ...plan, mutations: picked, cellMutations, sequencePattern },
      held: false,
      expired: true,
      nextLoops: hold.loops,
    };
  }

  // 黎明前钩子（归巢规划之前）：季节翻转 → master → harmonicFrame →（换季才）迁移
  // → flock 计划生效 → 发起复盘。色彩档日变只改高枝音，不强制迁移家枝。
  function handleBeforeDawn({ day, stats }, lifecycle) {
    reviewedSequencePattern = sequenceBridge.finishDay();
    patternHistory.push(patternOf(reviewedSequencePattern));
    settleHarmonyCounts(lifecycle); // H 日终入账：在鸣时长并入刚结束的一天
    pushScoreHistories(lifecycle); // 分数短历史：须在 masterInput 之前，含刚结束当天

    // Master USER 的季长只在日界应用；季节走向始终由 Agent 从菜单选择。
    if (masterControl === 'USER' && pendingUserSeasonLength != null) {
      cursor.seasonLength = Math.max(cursor.seasonDay + 1, pendingUserSeasonLength);
      pendingUserSeasonLength = null;
    }
    // 0) 季节翻转：昨天是季末日 → 今天入新季（master 预告优先，否则菜单顺挂）
    const wasFinalDay = cursor.seasonDay >= cursor.seasonLength - 1;
    let seasonChanged = false;
    if (wasFinalDay) {
      cursor.seasonIdx = pendingNext?.seasonIdx ?? (cursor.seasonIdx + 1) % config.harmony.seasons.length;
      cursor.seasonLength = pendingNext?.seasonLength ?? config.harmony.defaultSeasonLength;
      const nextSeason = config.harmony.seasons[cursor.seasonIdx];
      const allowedProgressions = config.harmony.bySeason[nextSeason]?.progressions ?? [];
      cursor.progressionId = allowedProgressions.some((item) => item.id === pendingNext?.progressionId)
        ? pendingNext.progressionId : (allowedProgressions[0]?.id ?? null);
      cursor.seasonDay = 0;
      cursor.daysSinceChange = 0;
      pendingNext = null;
      seasonChanged = true;
    } else {
      cursor.seasonDay += 1;
      cursor.daysSinceChange += 1;
    }
    const isFinalDay = cursor.seasonDay >= cursor.seasonLength - 1;

    const mInput = masterInput(stats, lifecycle);

    // 1) 领取流水线结果（flock + master，未就绪内部已回落）+ master 决策
    const dawnResult = pipelineRef
      ? callLifecycleBoundary(lifecycle, () => pipelineRef.dawnPlan())
      : null;
    const automaticMasterDecision = dawnResult ? dawnResult.master.decision : decideMaster(mInput);
    const masterDecision = masterControl === 'USER'
      ? { colorId: currentFrame.color.id, tension: currentFrame.tension, duskColorShift: false, reason: 'Master USER：暂停自动决策' }
      : automaticMasterDecision;
    const masterSource = masterControl === 'USER'
      ? 'USER' : dawnResult ? dawnResult.master.source : '规则层';
    if (masterControl !== 'USER') {
      callLifecycleBoundary(
        lifecycle,
        () => onTempoIntent?.(masterDecision?.tempoIntent ?? 'hold'),
      );
    }

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
          progressionId: masterDecision.progressionId,
        };
      }
    }

    // 3) 构建今日 harmonicFrame（上游给 color/tension 则用，否则规则兜底）→ 当日和弦
    const prevChord = currentChord;
    currentFrame = buildFrame(masterDecision);
    const progressionCycle = Math.floor(cursor.seasonDay / 4);
    duskColorShiftPlanned = masterControl !== 'USER'
      && masterDecision?.duskColorShift === true
      && (day - cursor.lastDuskShiftDay) >= 2
      && cursor.lastDuskShiftCycle !== progressionCycle;
    currentChord = chordFromFrame(currentFrame, config.harmony);
    commitColorState(currentFrame.color.id); // P1：回填 currentColorId/daysInColor
    pushBranchPreferences(lifecycle); // 当日 tension 生效后立即下发枝权重
    pushVocalizeBiases(lifecycle); // Track B：昨日错峰缺口 → 今日发声偏置（须在 pattern 定员前）
    callLifecycleBoundary(lifecycle, () => onMaster?.({
      day, decision: masterDecision, source: masterSource, frame: currentFrame, chord: currentChord, seasonChanged,
    }));

    // 4) 家枝迁移：只在换季日大迁移（voice-leading + seasonMigrationOnly 成批搬家）；
    //    季末日（非换季日）bass 收换季预告、提前聚集到最低允许枝，次日领迁移。
    const snap = callLifecycleBoundary(lifecycle, () => world.getSnapshot());
    const migrations = [];
    const chordChanged = prevChord?.id !== currentChord?.id;
    if (seasonChanged || chordChanged) {
      for (const treeSnap of snap.trees) {
        if (config.species[treeSnap.species]?.seasonMigrationOnly || treeSnap.species === 'texture') continue;
        if (!seasonChanged && typeof world.getTreeControl === 'function') {
          const treeControl = callLifecycleBoundary(
            lifecycle,
            () => world.getTreeControl(treeSnap.id),
          );
          if (treeControl === 'USER') continue;
        }
        const assignments = treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch }));
        const moves = migrateAssignments(prevChord, currentChord, assignments);
        for (const m of moves) {
          if (m.to !== m.from) {
            callLifecycleBoundary(
              lifecycle,
              () => world.setHomeBranch(m.birdId, m.to),
            );
            migrations.push({ treeId: treeSnap.id, ...m });
          }
        }
      }
      if (typeof world.applySeasonChange === 'function') {
        if (seasonChanged) {
          migrations.push(...callLifecycleBoundary(
            lifecycle,
            () => world.applySeasonChange(day),
          ));
        }
      }
    }
    if (!seasonChanged && isFinalDay) {
      for (const treeSnap of snap.trees) {
        const sp = config.species[treeSnap.species];
        if (!sp?.seasonMigrationOnly) continue;
        const rally = Math.min(...(sp.allowedBranches ?? [0]));
        for (const bird of treeSnap.birds) {
          if (bird.homeBranch !== rally && callLifecycleBoundary(
            lifecycle,
            () => world.setHomeBranch(bird.id, rally),
          )) {
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
      const treeControl = typeof world.getTreeControl === 'function'
        ? callLifecycleBoundary(lifecycle, () => world.getTreeControl(treeSnap.id))
        : null;
      if (treeControl === 'USER') {
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
        if (!plan) {
          plan = rulePlan(treeSnap, treeStats, lifecycle);
          source = '规则层(即时兜底)';
          reviewedDay = stats.day;
        }
      } else if (dawnResult && !dawnResult.flock.fallback && dawnResult.flock.plan) {
        const flockIdx = config.trees.findIndex((t) => t.id === treeSnap.id);
        const flockPlan = { flocks: [dawnResult.flock.plan.flocks?.[flockIdx]].filter(Boolean) };
        plan = flockPlan.flocks.length
          ? planFromLlm(
            flockPlan,
            treeSnap.birds.map((b) => ({ birdId: b.id, homeBranch: b.homeBranch })),
            treeStats,
            { ...config.agent, branchCount: config.tree.branches.length },
            sequenceEnabled ? sequencePatternSummary(reviewedSequencePattern, treeSnap.id) : null,
          )
          : null;
        if (!plan) {
          plan = rulePlan(treeSnap, treeStats, lifecycle);
          source = '规则层(兜底)';
        } else source = 'LLM';
        reviewedDay = dawnResult.reviewedDay ?? stats.day;
      } else {
        plan = rulePlan(treeSnap, treeStats, lifecycle);
        source = dawnResult ? '规则层(兜底)' : '规则层';
      }
      const bounded = filterMutationBounds(plan.mutations, config.tree.branches.length);
      const droppedForTree = [...(plan.droppedMutations ?? []), ...bounded.dropped];
      plan = { ...plan, mutations: bounded.accepted };
      // 乐句保持期（melody）：保持期内只冻家枝变异，期满小变。
      const held = applyHoldLoops(treeSnap.id, plan, lifecycle);
      plan = held.plan;
      const appliedMutations = [];
      for (const m of plan.mutations) {
        if (callLifecycleBoundary(
          lifecycle,
          () => world.setHomeBranch(m.birdId, m.to),
        )) appliedMutations.push(m);
        else droppedForTree.push({ ...m, reason: 'world-rejected' });
      }
      plan = { ...plan, mutations: appliedMutations };
      if (sequenceEnabled && plan.sequencePattern) {
        plannedSequencePatterns[treeSnap.id] = plan.sequencePattern;
        if (typeof world.setSequencePattern === 'function' && !callLifecycleBoundary(
          lifecycle,
          () => world.setSequencePattern(treeSnap.id, plan.sequencePattern),
        )) {
          droppedForTree.push({ cellMutations: plan.cellMutations ?? [], reason: 'world-sequence-rejected' });
        }
      }
      callLifecycleBoundary(
        lifecycle,
        () => world.setDensityTier(treeSnap.id, plan.densityTier),
      );
      callLifecycleBoundary(
        lifecycle,
        () => world.setFlockPlan(
          treeSnap.id,
          { dwellBeats: plan.dwellBeats, activeBars: plan.activeBars },
        ),
      );
      if (typeof world.setJungleEditPlan === 'function') {
        callLifecycleBoundary(
          lifecycle,
          () => world.setJungleEditPlan(treeSnap.id, plan.jungleEditPlan ?? null),
        );
      }
      const droppedEntries = droppedForTree.map((entry) => ({ treeId: treeSnap.id, ...entry }));
      dropped.push(...droppedEntries);
      appliedPlans[treeSnap.id] = { plan, source, reviewedDay, held: { ...held, plan }, dropped: droppedEntries };
    }
    if (evaluator) { pendingPlan = null; pendingSource = null; pendingReviewedDay = null; }

    callLifecycleBoundary(lifecycle, () => onApply?.({
      plans: appliedPlans, day, migrations, dropped, prevChord, nextChord: currentChord,
    }));
    if (prevChord.id !== currentChord.id || prevChord.season !== currentChord.season) {
      callLifecycleBoundary(
        lifecycle,
        () => onChord?.({ day, prevChord, nextChord: currentChord }),
      );
    }

    // 5) 发起当天复盘（第 N 天复盘第 N−1 天 → 第 N+1 天生效），随后重置 H 计数：
    //    ecology 通道的 onBeforeDawn 注册先于本钩子，读到的仍是刚结束当天的完整计数。
    if (pipelineRef) {
      const reviewPipeline = pipelineRef;
      const reviewPayload = {
        day: stats.day,
        flockSnapshot: flockInput(stats, lifecycle),
        masterInput: mInput,
      };
      callLifecycleBoundary(
        lifecycle,
        () => reviewPipeline.dayReview(reviewPayload),
      );
    } else if (evaluator) {
      runEvaluation(stats, lifecycle);
      assertLifecycle(lifecycle);
    }
    resetHarmonyCounts();
  }

  // 同一天不换和弦根；黄昏是否切色由当日 Master 决策显式给出，不再抛随机数。
  // Master USER 时完全不自动换色。
  // 黎明仍进入下一日和弦的日间色彩。
  function handleDusk({ day }, lifecycle) {
    if (masterControl === 'USER' || !duskColorShiftPlanned) return;
    duskColorShiftPlanned = false;
    const previous = currentChord;
    const dayColors = colorOptions(currentFrame.season, config.harmony, cursor.seasonDay, 'day', cursor.progressionId);
    const colorIndex = Math.max(0, dayColors.findIndex((color) => color.id === currentFrame.color.id));
    currentFrame = buildFrame({ tension: currentFrame.tension }, 'night', (colorIndex + 1) % dayColors.length);
    currentChord = chordFromFrame(currentFrame, config.harmony);
    cursor.lastDuskShiftDay = day;
    cursor.lastDuskShiftCycle = Math.floor(cursor.seasonDay / 4);
    pushBranchPreferences(lifecycle);
    if (previous.id !== currentChord.id) {
      callLifecycleBoundary(
        lifecycle,
        () => onChord?.({ day, prevChord: previous, nextChord: currentChord }),
      );
    }
  }

  function setReviewSource(nextSource) {
    if (disposed) throw disposedConductorError();
    const next = readReviewSource(nextSource);
    sourceGeneration += 1;
    reviewSourceRef = next;
    pipelineRef = next?.kind === 'pipeline-v1' || next?.kind === 'combined-v1'
      ? next.pipeline : null;
    evaluator = next?.kind === 'evaluator-v1' || next?.kind === 'combined-v1'
      ? next.evaluator : null;
    if (next === null) {
      pendingPlan = null;
      pendingSource = null;
      pendingReviewedDay = null;
    }
    return next;
  }

  function exportDeterministicState() {
    if (disposed) throw disposedConductorError();
    if (sequenceEnabled !== true) throw unsupportedConfigurationError();
    if (reviewSourceRef !== null || ecologyProvider !== null || getPercussionMode !== null) {
      throw nondeterministicSourceError();
    }
    const bridge = sequenceBridge.exportDeterministicState();
    return cloneStrictJson({
      conductor: {
        cursor: {
          ...cursor,
          lastDuskShiftDay: cursor.lastDuskShiftDay === -Infinity
            ? null : cursor.lastDuskShiftDay,
        },
        treeScoreHistory,
        harmonyScoreHistory,
        pendingNext,
        currentFrame,
        currentChord,
        pendingPlan,
        pendingSource,
        pendingReviewedDay,
        duskColorShiftPlanned,
        patternHistory,
        holdState,
        hCounts,
        hPerchStart: [...hPerchStart.entries()].map(([birdId, record]) => ({
          birdId,
          treeId: record.treeId,
          key: record.key,
          start: record.start,
        })),
      },
      sequence: {
        bridgeCurrent: bridge.current,
        bridgePrevious: bridge.previous,
        reviewedPattern: reviewedSequencePattern,
        plannedPatterns: plannedSequencePatterns,
      },
      control: {
        masterControl,
        pendingUserSeasonLength,
      },
    });
  }

  function invalidateLifecycle() {
    disposed = true;
    lifecycleGeneration += 1;
    sourceGeneration += 1;
    reviewSourceRef = null;
    pipelineRef = null;
    evaluator = null;
    pendingPlan = null;
    pendingSource = null;
    pendingReviewedDay = null;
  }

  function releaseSubscriptions(reverse = false) {
    const installed = reverse ? [...unsubscribers].reverse() : unsubscribers;
    for (const unsubscribe of installed) {
      try {
        unsubscribe();
      } catch {
        // 释放是 best-effort；一个坏 listener 不得阻止其余 owner 被注销。
      }
    }
  }

  function dispose() {
    if (disposed) return false;
    invalidateLifecycle();
    releaseSubscriptions();
    return true;
  }

  const guardListener = (listener) => (payload) => {
    if (disposed) return undefined;
    const lifecycle = lifecycleGeneration;
    try {
      return listener(payload, lifecycle);
    } catch (error) {
      if (error === LIFECYCLE_ABORT) return undefined;
      throw error;
    }
  };
  const installSubscription = (subscribe) => {
    const unsubscribe = subscribe();
    if (typeof unsubscribe !== 'function') {
      throw new TypeError('INVALID_CONDUCTOR_UNSUBSCRIBE');
    }
    unsubscribers.push(unsubscribe);
  };
  try {
    installSubscription(() => world.on('perch', guardListener(handleSequencePerch)));
    installSubscription(() => world.on('perch', guardListener(handleHarmonyPerch)));
    installSubscription(() => world.on('unperch', guardListener(handleHarmonyUnperch)));
    installSubscription(() => world.onBeforeDawn(guardListener(handleBeforeDawn)));
    installSubscription(() => world.on('dusk', guardListener(handleDusk)));
  } catch (error) {
    invalidateLifecycle();
    releaseSubscriptions(true);
    throw error;
  }

  return {
    getChord: () => currentChord,
    getFrame: () => currentFrame,
    getHarmonyScores: () => harmonyScores(),
    getSequencePattern: () => sequenceBridge.getCurrent(),
    getPlannedSequencePattern: (treeId) => plannedSequencePatterns[treeId] ?? null,
    getReviewedSequencePattern: () => reviewedSequencePattern,
    getMasterState: () => ({
      control: masterControl,
      season: currentFrame.season,
      seasonDay: cursor.seasonDay,
      seasonLength: cursor.seasonLength,
      colorId: currentFrame.color.id,
      period: currentFrame.period,
      progressionStep: currentFrame.progressionStep,
      progressionCycle: currentFrame.progressionCycle,
      progressionId: currentFrame.progressionId,
      pendingSeasonLength: pendingUserSeasonLength,
    }),
    setMasterControl, setUserSeasonLength, applyUserColor,
    hasPendingPlan: () => !!pendingPlan,
    setReviewSource,
    getHoldState: (treeId) => ({ ...holdState[treeId] }),
    exportDeterministicState,
    dispose,
  };
}
