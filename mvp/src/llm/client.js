// MiniMax 批量生态决策客户端。
// 单次请求覆盖全部 flock；API key 仅由调用方注入，模块不读环境或本地文件。

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
1) 只依据昼夜、季节、物种、体力、栖飞比例、树况和当日活动统计判断。
2) dwellBeats 是单次枝头驻留持续的拍数；必须落在该鸟群 menu.dwellBeats 内。
3) activeBars 是活跃窗口=当日前 N 小节（自小节 0 起硬截断，与物种时段求交），0 表示全日静默；取值必须落在 menu.activeBars 内。
4) holdLoops 是同一乐句习性保持的循环数，固定只可在 2–8 个循环内，并必须从 menu.holdLoops 的整数范围选择；保持期内不得提出新的家枝变异。
5) mutations 是少量家枝变异建议，每项格式为 {"from":非负整数,"to":非负整数}，from 与 to 不得相同；没有建议时给空数组，不得超过 menu.maxMutations。
6) 输入鸟群如提供 ecology 偏好带复盘，则参考其中每循环换枝次数、平均驻留拍数、群聚规模、得分与偏离；未提供时不要臆测。
7) flocks 必须与输入鸟群数量和顺序完全一致，四个字段缺一不可。
8) master.ops 当前必须是空数组。
只输出一行 JSON，不要代码围栏、解释或推理。精确形状：{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}`;

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
  for (const key of ['branchChangesPerLoop', 'meanDwellBeats', 'clusterSize', 'score']) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) ecology[key] = number;
  }
  const deviation = normalizeDeviation(value.deviation);
  if (deviation !== undefined) ecology.deviation = deviation;
  return Object.keys(ecology).length ? ecology : undefined;
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
      return {
        species: cleanText(flock.species, 48),
        energy: clamp(finite(flock.energy, 0.5), 0, 1),
        perchFlyRatio: clamp(finite(flock.perchFlyRatio, 0.5), 0, 1),
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

export function normalizeWorldPlan(raw, expectedFlockCount, menus = []) {
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
      return normalizeWorldPlan(parsed, ecology.flocks.length, ecology.flocks.map((flock) => flock.menu));
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
