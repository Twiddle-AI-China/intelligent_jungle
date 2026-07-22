import {
  MINIMAX_BASE_URL,
  MINIMAX_MODEL,
  extractFirstJsonObject,
} from '../llm/client.js';
import {
  attachMasterDecisionEvidence,
  canonMasterMenu,
  normalizeMasterDecision,
} from './policy.js';

export const MASTER_SYSTEM_PROMPT = `你是森林四季的和声守望者。一季从受限 progression 菜单选一条和声骨架路径；每个黎明为明天选择当季菜单内的 colorId、tensionRange 内的 tension 张力预算，并用 duskColorShift 决定本日黄昏是否做一次同根色彩变化。
不要展开思考、不要自行比较 treeScores、harmonyScores、patternSimilarity、seasonDay 或任何数值；只读取 flags 并按以下优先级映射动作：
1) seasonFinal=true：可选择菜单内 nextSeason、该季 progressionId，并从 seasonLengthRange 选择 seasonLength；否则三者必须省略或为 null。
2) cooldownActive=true：保持 currentColorId，不主动改变张力方向。
3) imbalanceStreak=true：换到当季另一个 colorId，张力维持基线，一次只改一维。
4) imbalanceToday=true：保持 colorId，张力向上微调并 clamp 到 tensionRange。
5) freshnessDue=true：换到当季另一个 colorId；similarityHigh=true 只强化此动作，不单独触发。
6) 以上动作开关均为 false：按菜单温和轮转 colorId，张力随季节进度温和变化。
duskColorShift 必须是 boolean，并保持克制：cooldownActive 或 imbalanceToday 时选 false；只有 freshnessDue、similarityHigh 或 imbalanceStreak 提示需要日内对比时才可选 true。它是你的显式音乐决策，不得用随机概率。
tempoIntent 只能是 hold、slower、faster；默认 hold，不因单日低分改变速度，确需改变时每天最多移动一档。
colorId 只能取当季 colors 菜单 id；不得发明或组合。数值只按规则给出的方向选择并 clamp，不计算阈值或公式。reason 只写触发开关与动作的短句，不写分析过程。
只输出一行 JSON，不要代码围栏、解释、比较过程或推理。普通日形状：{"colorId":"菜单id","tension":0.3,"duskColorShift":false,"tempoIntent":"hold","reason":"开关与动作"}；仅 seasonFinal=true 时可加 "nextSeason":"菜单内季节id","progressionId":"该季菜单id","seasonLength":整数。`;

function numericArray(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.slice(0, 32).map((entry) => {
    if (Array.isArray(entry)) return entry.slice(-32).map(Number).filter(Number.isFinite);
    const number = Number(entry);
    return Number.isFinite(number) ? number : null;
  }).filter((entry) => entry !== null && (!Array.isArray(entry) || entry.length));
  return normalized.length ? normalized : null;
}

const MASTER_FLAG_THRESHOLDS = Object.freeze({
  scoreFloor: 0.65, hardFloor: 0.4, medianGap: 0.2,
  streakDays: 2, boredDays: 3, similarity: 0.82, cooldownDays: 2,
});

function histories(value) {
  return Array.isArray(value) ? value.map((entry) => Array.isArray(entry) ? entry : [entry]) : [];
}

// 与 policy 的既有三观阈值对齐，但只做输入投影：LLM 只看开关，不承担数值比较。
export function buildMasterFlags({ menu = {}, state = {}, observations = {} } = {}) {
  const scores = [...histories(observations.treeScores), ...histories(observations.harmonyScores ?? observations.harmonyScore)]
    .map((series) => series.map(Number).filter(Number.isFinite)).filter((series) => series.length);
  const todayValues = scores.map((series) => series.at(-1)).sort((a, b) => a - b);
  const median = todayValues.length
    ? (todayValues[Math.floor((todayValues.length - 1) / 2)]
      + todayValues[Math.ceil((todayValues.length - 1) / 2)]) / 2 : 1;
  const isLow = (value) => value < MASTER_FLAG_THRESHOLDS.hardFloor
    || (value < MASTER_FLAG_THRESHOLDS.scoreFloor
      && median - value >= MASTER_FLAG_THRESHOLDS.medianGap);
  let maxLowStreak = 0;
  let imbalanceToday = false;
  for (const series of scores) {
    if (isLow(series.at(-1))) imbalanceToday = true;
    let streak = 0;
    for (let i = series.length - 1; i >= 0 && isLow(series[i]); i -= 1) streak += 1;
    maxLowStreak = Math.max(maxLowStreak, streak);
  }
  const seasonDay = Number(state.seasonDay ?? state.daysInSeason);
  const seasonLength = Number(state.seasonLength);
  const daysSinceChange = Number(state.daysSinceChange);
  const daysInColor = Number(state.daysInColor ?? state.colorDays ?? state.sameColorDays);
  const similarity = Number(observations.patternSimilarity);
  return {
    seasonFinal: Number.isInteger(seasonDay) && Number.isInteger(seasonLength)
      && seasonLength > 0 && seasonDay >= seasonLength - 1,
    cooldownActive: Number.isFinite(daysSinceChange) && daysSinceChange >= 0
      && daysSinceChange < MASTER_FLAG_THRESHOLDS.cooldownDays,
    imbalanceStreak: maxLowStreak >= MASTER_FLAG_THRESHOLDS.streakDays,
    imbalanceToday,
    freshnessDue: Number.isFinite(daysInColor) && daysInColor >= MASTER_FLAG_THRESHOLDS.boredDays,
    similarityHigh: Number.isFinite(similarity) && similarity >= MASTER_FLAG_THRESHOLDS.similarity,
  };
}

// 归一化 master 输入：菜单收敛为 {seasons, colorsBySeason, seasonLengthRange, tensionRange}，
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
    flags: buildMasterFlags({ menu, state, observations }),
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
      const decision = normalizeMasterDecision(raw, input.menu, input.state);
      return attachMasterDecisionEvidence(decision, input);
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
