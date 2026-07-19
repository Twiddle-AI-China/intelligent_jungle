import {
  MINIMAX_BASE_URL,
  MINIMAX_MODEL,
  extractFirstJsonObject,
} from '../llm/client.js';
import { canonMasterMenu, normalizeMasterDecision } from './policy.js';

export const MASTER_SYSTEM_PROMPT = `你是森林四季的和声守望者。一季只有一个固定的和声骨架（低枝根音整季不动），你不能改动它；你在每个黎明只为明天做两个选择：
1) colorId：从当季 colors 色彩菜单选一档——同一骨架的明暗呼吸，只能选菜单内 id，不得发明或组合。
2) tension：0 到 1 的张力预算，表示明天允许各树偏离骨架枝的程度；0 最收敛，1 最自由。
只有在季的最后一天（seasonDay 达到 seasonLength-1），你才额外输出菜单内的 nextSeason 与整数 seasonLength（必须落在 seasonLengthRange 范围内）；其他日子输出这两个字段视为违规。
输入会给出各树昨日和谐得分 harmonyScores（0..1，越高越贴合骨架）与生态得分 treeScores：和谐得分高可适当放宽张力，和谐得分低或生态失衡则收紧。每次决策只能改变当日色彩与张力，季节更替只发生在季末日。
只输出一行 JSON，不要代码围栏、解释或推理。精确形状：{"colorId":"当季菜单内的色彩档id","tension":0.3,"reason":"生态理由"}；季末日额外加 "nextSeason":"菜单内季节id","seasonLength":整数。`;

function numericArray(value) {
  return Array.isArray(value) ? value.slice(0, 32).map(Number).filter(Number.isFinite) : null;
}

// 归一化 master 输入：菜单收敛为 {seasons, colorsBySeason, seasonLengthRange}，
// state 归一为 {season, seasonDay, seasonLength, currentColorId}（宽容读新旧字段名），
// observations 额外透传各树昨日和谐得分 harmonyScores（供 tension 决策依据）。
export function normalizeMasterInput({ menu = {}, state = {}, observations = {} } = {}) {
  const treeScores = numericArray(observations.treeScores);
  const harmonyScores = numericArray(observations.harmonyScores ?? observations.harmonyScore);
  const seasonLength = Number(state.seasonLength);
  const currentColorId = state.currentColorId ?? state.colorId;
  return {
    menu: canonMasterMenu(menu),
    state: {
      season: typeof state.season === 'string' ? state.season : (state.currentSeason ?? null),
      seasonDay: Number.isInteger(Number(state.seasonDay ?? state.daysInSeason))
        ? Number(state.seasonDay ?? state.daysInSeason) : 0,
      seasonLength: Number.isInteger(seasonLength) ? seasonLength : null,
      currentColorId: typeof currentColorId === 'string' ? currentColorId : null,
    },
    observations: {
      ...(treeScores ? { treeScores } : {}),
      ...(harmonyScores ? { harmonyScores } : {}),
      patternSimilarity: Number.isFinite(Number(observations.patternSimilarity))
        ? Number(observations.patternSimilarity) : 0,
    },
  };
}

export class MasterLlmClient {
  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = MINIMAX_BASE_URL,
    model = MINIMAX_MODEL,
  } = {}) {
    if (!apiKey) throw new Error('MasterLlmClient: apiKey is required');
    if (typeof fetchImpl !== 'function') throw new Error('MasterLlmClient: fetch implementation is required');
    this.apiKey = apiKey;
    // 同 MinimaxClient：原生 fetch this 敏感，实例方法调用需脱敏包装。
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
  }

  async requestDecision(input = {}, { signal } = {}) {
    const normalized = normalizeMasterInput(input);
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
          temperature: 0.2,
          max_tokens: 300,
          messages: [
            { role: 'system', content: MASTER_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(normalized) },
          ],
        }),
      });
      if (!response?.ok) return null;
      const data = await response.json();
      if (data?.base_resp && Number(data.base_resp.status_code) !== 0) return null;
      const raw = extractFirstJsonObject(data?.choices?.[0]?.message?.content);
      return normalizeMasterDecision(raw, input.menu, input.state);
    } catch {
      return null;
    }
  }

  requestDayPlan(input, options) {
    return this.requestDecision(input, options);
  }
}

export function createMasterLlmClient(options) {
  return new MasterLlmClient(options);
}
