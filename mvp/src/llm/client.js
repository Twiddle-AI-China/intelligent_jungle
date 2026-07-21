// MiniMax 批量生态决策客户端。
// 单次请求覆盖全部 flock；API key 仅由调用方注入，模块不读环境或本地文件。

import { applySequenceCellMutations } from '../sequence.js';

export const MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1';
export const MINIMAX_MODEL = 'abab6.5s-chat';

const DEFAULT_DECISION_MENU = Object.freeze({
  dwellBeats: Object.freeze([0.25, 16]),
  activeBars: Object.freeze([0, 4]),
  holdLoops: Object.freeze([2, 8]),
  maxMutations: 8,
});

// MiniMax abab6.5s-chat 不支持 response_format，因此 prompt 强制单行 JSON，
// 响应端再做平衡括号提取和严格形状校验。全文只使用生态与节拍词汇。
export const MINIMAX_SYSTEM_PROMPT = `你是一个生态群落的日界规划器。一次评估所有鸟群，为下一昼夜给出温和的行为倾向。遵守以下规则：
不要展开思考、不要自行比较任何数值；只读取每群 flags 中的布尔开关并按优先级映射动作：
1) dwellLow=true：提高 dwellBeats，朝 dwellPreferenceBeats 方向选择，并 clamp 到 menu.dwellBeats。
2) dwellHigh=true：降低 dwellBeats，朝 dwellPreferenceBeats 方向选择，并 clamp 到 menu.dwellBeats。
3) branchChangesLow=true 或 onsetCountLow=true：提高 activeBars；前者可建议少量家枝变异，后者只调密度/窗口。
4) branchChangesHigh=true 或 onsetCountHigh=true：降低 activeBars 或提高 holdLoops，减少变动/起音。
5) intervalRegularityLow=true：用一条 cellMutation 把最密的起音移到最大时间空隙，不增删格。
6) clusterLow=true 时提高 activeBars 并分散合法家枝；clusterHigh=true 时降低 activeBars 或提高 holdLoops。
7) tensionHigh=true（张力开关）才可建议迁往 colorBranchIds（色彩枝）；tensionLow=true 时只守 skeletonBranchIds（骨架枝）。
8) 上述偏离开关均为 false：保持温和稳定，不强造变异。
dwellBeats 是驻留拍数；activeBars 是自小节 0 起硬截断、与物种时段求交的活跃窗口，0 表示全日静默；holdLoops 是同一栖枝格局保持 2–8 个循环。所有数值只按上述方向选择并 clamp 到各自 menu，不计算公式。
mutations 每项为 {"from":非负整数,"to":非负整数}；from 必须来自 homeBranches，from 与 to 不同，最多 menu.maxMutations 条。
cellMutations 每项为 {"from":{"pitchBranchId":整数,"stepIndex":整数},"to":{"pitchBranchId":整数,"stepIndex":整数}}；from 必须是 sequencePattern.occupiedCells 中的已占格，to 必须是同一 5×16 菜单内的空格；最多 menu.maxMutations 条。没有 sequencePattern 时必须给空数组。flocks 数量与输入顺序一致且五字段齐全；master.ops 必须为空数组。
只输出一行 JSON，不要代码围栏、解释、比较过程或推理。精确形状：{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[{"from":0,"to":1}],"cellMutations":[]}],"master":{"ops":[]}}`;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const cleanText = (value, max = 80) => typeof value === 'string'
  ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max)
  : '';

function jsonSafeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // 3.5.3 后不再把秒制驻留观测送入模型；旧快照出现时静默忽略。
    // 双保险：音高类键（notes/root/midi/chord）一律拒绝，绝不进请求体。
    if (/note|root|midi|chord/i.test(key)) continue;
    if (/seconds?|meanDwell|dwellTime|dwellBase/i.test(key) && !/beats/i.test(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else if (typeof item === 'boolean' || item === null) out[key] = item;
    else if (typeof item === 'string') out[key] = cleanText(item, 120);
    else if (Array.isArray(item)) {
      out[key] = item.slice(0, 32).map((entry) => {
        if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
        if (typeof entry === 'string') return cleanText(entry, 80);
        return null;
      });
    }
  }
  return out;
}

function normalizeDeviation(value) {
  if (typeof value === 'string') return cleanText(value, 160);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    if (typeof item === 'string') out[key] = cleanText(item, 40);
    else if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const direction = cleanText(item.direction, 16);
      const amount = Number(item.amount ?? item.magnitude);
      out[key] = {
        ...(direction ? { direction } : {}),
        ...(Number.isFinite(amount) ? { amount } : {}),
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEcologyReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ecology = {};
  for (const key of [
    'branchChangesPerLoop', 'sequenceOnsetCount', 'intervalRegularity',
    'meanDwellBeats', 'clusterSize', 'clusterPeak', 'score', 'harmonyScore',
  ]) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) ecology[key] = number;
  }
  const deviation = normalizeDeviation(value.deviation);
  if (deviation !== undefined) ecology.deviation = deviation;
  return Object.keys(ecology).length ? ecology : undefined;
}

function deviationDirection(deviation, ...keys) {
  for (const key of keys) {
    const value = deviation?.[key];
    const direction = typeof value === 'string' ? value : value?.direction;
    if (direction === 'low' || direction === 'high' || direction === 'within') return direction;
  }
  return 'within';
}

// PromptLab §2.5：阈值/偏好带比较一律在调用方完成。生态 deviation 已由
// economy 算好方向；这里仅把方向投影成稳定布尔开关，模型不再读取数值做比较。
export function buildFlockFlags({ ecology, tension } = {}) {
  const deviation = ecology?.deviation;
  const dwell = deviationDirection(deviation, 'meanDwell', 'meanDwellBeats', 'dwell');
  const changes = deviationDirection(deviation, 'branchChanges', 'branchChangesPerLoop');
  const onsets = deviationDirection(deviation, 'onsetCount', 'sequenceOnsetCount');
  const regularity = deviationDirection(deviation, 'intervalRegularity');
  const cluster = deviationDirection(deviation, 'cohortSize', 'clusterSize', 'cluster');
  const numericTension = Number(tension);
  return {
    dwellLow: dwell === 'low',
    dwellHigh: dwell === 'high',
    branchChangesLow: changes === 'low',
    branchChangesHigh: changes === 'high',
    onsetCountLow: onsets === 'low',
    onsetCountHigh: onsets === 'high',
    intervalRegularityLow: regularity === 'low',
    clusterLow: cluster === 'low',
    clusterHigh: cluster === 'high',
    tensionHigh: Number.isFinite(numericTension) && numericTension >= 0.6,
    tensionLow: Number.isFinite(numericTension) && numericTension <= 0.35,
  };
}

const SPECIES_DWELL_PREFERENCES = Object.freeze({
  melody: Object.freeze({ lo: 0.5, hi: 2 }),
  pad: Object.freeze({ lo: 8 }),
  bass: Object.freeze({ lo: 3 }),
  texture: Object.freeze({ lo: 1, hi: 4 }),
});

function speciesDwellPreference(species) {
  const preference = SPECIES_DWELL_PREFERENCES[String(species ?? '').trim().toLowerCase()];
  return preference ? { ...preference } : undefined;
}

function normalizeRange(value, fallback, { integer = false, hardMin = 0, hardMax = Infinity } = {}) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' ? [value.lo ?? value.min, value.hi ?? value.max] : [];
  let lo = finite(source[0], fallback[0]);
  let hi = finite(source[1], fallback[1]);
  lo = clamp(lo, hardMin, hardMax);
  hi = clamp(hi, hardMin, hardMax);
  if (integer) {
    lo = Math.ceil(lo);
    hi = Math.floor(hi);
  }
  if (hi < lo) [lo, hi] = [hi, lo];
  return [lo, hi];
}

export function normalizeDecisionMenu(value = {}) {
  const menu = value && typeof value === 'object' ? value : {};
  return {
    dwellBeats: normalizeRange(
      menu.dwellBeats ?? menu.dwellBeatsRange,
      DEFAULT_DECISION_MENU.dwellBeats,
      { hardMin: 0.0625 },
    ),
    activeBars: normalizeRange(
      menu.activeBars ?? menu.activeBarsRange,
      DEFAULT_DECISION_MENU.activeBars,
      { integer: true, hardMin: 0 },
    ),
    // 乐句保持期的全局安全边界固定为 2–8，菜单可在其中进一步收窄。
    holdLoops: normalizeRange(
      menu.holdLoops ?? menu.holdLoopsRange,
      DEFAULT_DECISION_MENU.holdLoops,
      { integer: true, hardMin: 2, hardMax: 8 },
    ),
    maxMutations: clamp(Math.floor(finite(menu.maxMutations ?? menu.maxMutationsPerDay, 8)), 0, 8),
  };
}

// 枝 id 集合只收非负整数；生态 frame 投影（harmony-season-redesign §3 + music-leak P0-1）：
// tension 夹到 [0,1]，枝 id 数组过滤非法项，colorId 收敛为短文本。
// flock 级优先，快照根级兜底；缺省一律省略字段。
function branchIds(value) {
  return Array.isArray(value)
    ? value.filter((x) => Number.isInteger(x) && x >= 0).slice(0, 16)
    : null;
}

function frameProjection(snapshot, flock) {
  const out = {};
  const tension = Number(flock.tension ?? snapshot.tension);
  if (Number.isFinite(tension)) out.tension = clamp(tension, 0, 1);
  const skeleton = branchIds(flock.skeletonBranchIds ?? snapshot.skeletonBranchIds);
  if (skeleton) out.skeletonBranchIds = skeleton;
  const color = branchIds(flock.colorBranchIds ?? snapshot.colorBranchIds);
  if (color) out.colorBranchIds = color;
  const colorId = flock.colorId ?? snapshot.colorId;
  if (typeof colorId === 'string' && colorId.trim()) out.colorId = cleanText(colorId, 48);
  return out;
}

function normalizeSequencePattern(value) {
  if (!value || typeof value !== 'object' || value.version !== 2) return undefined;
  const pitchBranchCount = Math.max(1, Math.min(16, Math.floor(finite(value.pitchBranchCount, 5))));
  const stepCount = Math.max(1, Math.min(64, Math.floor(finite(value.stepCount, 16))));
  const occupiedCells = Array.isArray(value.occupiedCells)
    ? value.occupiedCells.slice(0, 128).flatMap((cell) => {
      const pitchBranchId = Number(cell?.pitchBranchId);
      const stepIndex = Number(cell?.stepIndex);
      const count = Math.max(1, Math.min(32, Math.floor(finite(cell?.count, 1))));
      return Number.isInteger(pitchBranchId) && pitchBranchId >= 0 && pitchBranchId < pitchBranchCount
        && Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < stepCount
        ? [{ pitchBranchId, stepIndex, count }]
        : [];
    })
    : [];
  return { version: 2, pitchBranchCount, stepCount, occupiedCells };
}

export function normalizeEcologySnapshot(snapshot = {}) {
  const flocks = Array.isArray(snapshot.flocks) ? snapshot.flocks : [];
  const worldMenu = normalizeDecisionMenu(snapshot.decisionMenu ?? snapshot.planMenu ?? snapshot.menu);
  return {
    day: Math.max(0, Math.floor(finite(snapshot.day, 0))),
    dayPhase: typeof snapshot.dayPhase === 'string'
      ? cleanText(snapshot.dayPhase, 24)
      : clamp(finite(snapshot.dayPhase ?? snapshot.phase, 0), 0, 1),
    season: snapshot.season == null ? null : cleanText(String(snapshot.season), 32),
    flocks: flocks.map((flock = {}) => {
      const ecology = normalizeEcologyReview(flock.ecology);
      const dwellPreferenceBeats = speciesDwellPreference(flock.species);
      const projection = frameProjection(snapshot, flock);
      const sequencePattern = normalizeSequencePattern(flock.sequencePattern);
      const harmonyScore = Number(flock.harmonyScore);
      return {
        species: cleanText(flock.species, 48),
        // PRD §2 物种偏好带直接随请求发送，避免模型把四树都压成 4 拍。
        ...(dwellPreferenceBeats ? { dwellPreferenceBeats } : {}),
        energy: clamp(finite(flock.energy, 0.5), 0, 1),
        perchFlyRatio: clamp(finite(flock.perchFlyRatio, 0.5), 0, 1),
        // 现有家枝列表透传给模型：mutations.from 只能从中取（agent.js flockInput 产出）。
        ...(Array.isArray(flock.homeBranches)
          ? { homeBranches: flock.homeBranches.filter(Number.isInteger).slice(0, 32) }
          : {}),
        ...(sequencePattern ? { sequencePattern } : {}),
        ...(Number.isFinite(harmonyScore) ? { harmonyScore: clamp(harmonyScore, 0, 1) } : {}),
        // 生态 frame 投影：tension + 骨架/色彩枝 id 集合 + colorId（绝不含音高）。
        ...projection,
        flags: buildFlockFlags({ ecology, tension: projection.tension }),
        treeCondition: jsonSafeRecord(flock.treeCondition ?? flock.tree),
        dailyStats: jsonSafeRecord(flock.dailyStats ?? flock.stats),
        ...(ecology ? { ecology } : {}),
        menu: normalizeDecisionMenu(flock.decisionMenu ?? flock.planMenu ?? flock.menu ?? worldMenu),
      };
    }),
  };
}

// 返回内容中的第一个可解析 JSON 对象。扫描器理解字符串转义和嵌套对象，
// 不会被 reason 文本中的花括号或 Markdown 代码围栏扰乱。
export function extractFirstJsonObject(content) {
  if (typeof content !== 'string') return null;
  for (let start = content.indexOf('{'); start >= 0; start = content.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < content.length; i += 1) {
      const char = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(content.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

function normalizeMutations(value, maxMutations) {
  if (!Array.isArray(value)) return [];
  const mutations = [];
  for (const suggestion of value.slice(0, maxMutations)) {
    if (!suggestion || typeof suggestion !== 'object') continue;
    const from = Number(suggestion.from ?? suggestion.fromBranch);
    const to = Number(suggestion.to ?? suggestion.toBranch);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from === to) continue;
    mutations.push({ from, to });
  }
  return mutations;
}

export function normalizeWorldPlan(raw, expectedFlockCount, menus = [], sequencePatterns = []) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.flocks)) return null;
  if (!raw.master || typeof raw.master !== 'object' || !Array.isArray(raw.master.ops)) return null;
  if (raw.master.ops.length !== 0) return null;
  if (raw.flocks.length !== expectedFlockCount) return null;
  const flocks = [];
  for (let index = 0; index < raw.flocks.length; index += 1) {
    const decision = raw.flocks[index];
    if (!decision || typeof decision !== 'object') return null;
    if (!Array.isArray(decision.mutations)) return null;
    const dwellBeats = Number(decision.dwellBeats);
    const activeBars = Number(decision.activeBars);
    const holdLoops = Number(decision.holdLoops);
    if (!Number.isFinite(dwellBeats) || !Number.isFinite(activeBars) || !Number.isInteger(holdLoops)) return null;
    const menu = normalizeDecisionMenu(menus[index]);
    if (holdLoops < menu.holdLoops[0] || holdLoops > menu.holdLoops[1]) return null;
    const hasCellMutations = Object.hasOwn(decision, 'cellMutations');
    const rawCellMutations = decision.cellMutations ?? [];
    if (!Array.isArray(rawCellMutations)) return null;
    const sequencePattern = sequencePatterns[index];
    const cellResult = sequencePattern
      ? applySequenceCellMutations(sequencePattern, rawCellMutations, { maxMutations: menu.maxMutations })
      : (rawCellMutations.length ? null : { mutations: [] });
    if (!cellResult) return null;
    // clamp 是设计内行为，但夹过要留痕：否则调试时分不清「模型差」还是「被夹」。
    const clampedDwellBeats = clamp(dwellBeats, menu.dwellBeats[0], menu.dwellBeats[1]);
    if (clampedDwellBeats !== dwellBeats) {
      console.debug(`normalizeWorldPlan: flock${index} dwellBeats clamp ${dwellBeats} → ${clampedDwellBeats}`);
    }
    const clampedActiveBars = clamp(Math.round(activeBars), menu.activeBars[0], menu.activeBars[1]);
    if (clampedActiveBars !== activeBars) {
      console.debug(`normalizeWorldPlan: flock${index} activeBars clamp ${activeBars} → ${clampedActiveBars}`);
    }
    flocks.push({
      dwellBeats: clampedDwellBeats,
      activeBars: clampedActiveBars,
      holdLoops,
      mutations: normalizeMutations(decision.mutations, menu.maxMutations),
      ...(hasCellMutations ? { cellMutations: cellResult.mutations } : {}),
    });
  }
  // master 是协议保留位；本阶段不让外部模型直接改变世界，只接受严格的空操作集。
  return { flocks, master: { ops: [] } };
}

export class MinimaxClient {
  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = MINIMAX_BASE_URL,
    model = MINIMAX_MODEL,
  } = {}) {
    if (!apiKey) throw new Error('MinimaxClient: apiKey is required');
    if (typeof fetchImpl !== 'function') throw new Error('MinimaxClient: fetch implementation is required');
    this.apiKey = apiKey;
    // 浏览器原生 fetch 是 this 敏感的：存到实例后经 this.fetchImpl(...) 调用
    // 会以 client 为 this 抛 Illegal invocation（node 不受影响）。统一脱敏。
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
  }

  async requestDayPlan(snapshot, { signal } = {}) {
    const ecology = normalizeEcologySnapshot(snapshot);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.25,
          max_tokens: 700,
          messages: [
            { role: 'system', content: MINIMAX_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(ecology) },
          ],
        }),
      });
      if (!response?.ok) return null;
      const data = await response.json();
      // MiniMax 可能在 HTTP 200 内通过 base_resp 表示业务失败。
      if (data?.base_resp && Number(data.base_resp.status_code) !== 0) return null;
      const parsed = extractFirstJsonObject(data?.choices?.[0]?.message?.content);
      return normalizeWorldPlan(
        parsed,
        ecology.flocks.length,
        ecology.flocks.map((flock) => flock.menu),
        ecology.flocks.map((flock) => flock.sequencePattern),
      );
    } catch {
      // 网络、AbortError、无效 JSON 均交给调度器记失败，调用方走纯规则兜底。
      return null;
    }
  }

  requestWorldPlan(snapshot, options) {
    return this.requestDayPlan(snapshot, options);
  }
}

export function createMinimaxClient(options) {
  return new MinimaxClient(options);
}

// provider 链（T14）：bird_agent → MiniMax →（调用方的）规则兜底。
// 前一层返回 null 或抛错即落下一层；全部 null 由调用方走规则兜底。
export function chainProviders(...providers) {
  const chain = providers.flat().filter(Boolean);
  async function firstResult(method, input, options) {
    for (const provider of chain) {
      if (typeof provider?.[method] !== 'function') continue;
      try {
        const result = await provider[method](input, options);
        if (result) return result;
      } catch { /* 落下一层 */ }
    }
    return null;
  }
  return {
    requestDayPlan: (snapshot, options) => firstResult('requestDayPlan', snapshot, options),
    requestDecision: (input, options) => firstResult('requestDecision', input, options),
  };
}
