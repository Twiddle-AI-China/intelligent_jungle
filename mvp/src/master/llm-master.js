import {
  MINIMAX_BASE_URL,
  MINIMAX_MODEL,
  extractFirstJsonObject,
} from '../llm/client.js';
import { normalizeMasterDecision } from './policy.js';

export const MASTER_SYSTEM_PROMPT = `你是森林四季的天气与繁荣守望者。你只能从来访者给出的季节、色彩和路径菜单中选择明日景观，绝不能新增、改写或组合菜单外选项。树况长期失衡时优先换路径步骤；景观连续相似且季节已成熟时可换季；如提供 treeScores 则参考各树繁荣得分。树上行为只按枝头驻留拍数、活跃窗口小节数与乐句习性保持循环数理解；保持期为 2–8 个循环，期内不变异。每次只能改变路径步骤或季节色彩一个维度，冷却期内不得换季。只输出一行 JSON，不要代码围栏、解释或推理。精确形状：{"advanceStep":true,"reason":"生态理由"}；停留时 advanceStep 为 false；跳步时另给 "jumpToStep"；换季时 advanceStep 必须为 false，且同时给出菜单内的 "changeSeason" 与 "nextPalette"。`;

function musicObservation(value) {
  if (Array.isArray(value)) return value.slice(0, 16).map(Number).filter(Number.isFinite);
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export function normalizeMasterInput({ menu = {}, state = {}, observations = {} } = {}) {
  const treeScores = Array.isArray(observations.treeScores)
    ? observations.treeScores.slice(0, 32).map(Number).filter(Number.isFinite)
    : null;
  return {
    menu: {
      paths: Array.isArray(menu.progressions) ? menu.progressions : [],
      seasonPalettes: menu.seasonPalettes && typeof menu.seasonPalettes === 'object' ? menu.seasonPalettes : {},
      seasonLengthRange: Array.isArray(menu.seasonLengthRange) ? menu.seasonLengthRange : [],
      cooldownDays: Number.isFinite(Number(menu.cooldownDays)) ? Number(menu.cooldownDays) : 0,
    },
    state: {
      currentSeason: state.currentSeason ?? null,
      currentStep: Number.isInteger(Number(state.currentStep)) ? Number(state.currentStep) : 0,
      daysInSeason: Number.isInteger(Number(state.daysInSeason)) ? Number(state.daysInSeason) : 0,
      daysSinceChange: Number.isInteger(Number(state.daysSinceChange)) ? Number(state.daysSinceChange) : 0,
      currentProgression: Number.isInteger(Number(state.currentProgression)) ? Number(state.currentProgression) : undefined,
    },
    observations: {
      ...(treeScores ? { treeScores } : {}),
      patternSimilarity: Number.isFinite(Number(observations.patternSimilarity))
        ? Number(observations.patternSimilarity) : 0,
      avgDwellBeats: musicObservation(observations.avgDwellBeats ?? observations.meanDwellBeats),
      activeBars: musicObservation(observations.activeBars),
      holdLoops: musicObservation(observations.holdLoops),
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
