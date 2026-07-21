// bird_agent 本地推理后端客户端（OpenAI 兼容，docs/api-8081-bird-agent.md）。
// 与 MiniMax 并存：provider 优先级 bird_agent → MiniMax → 规则兜底
// （master 侧 external → llm → policy，llm 层内同样按此链选择）。
// 实测要点全部落实：json_schema 结构化输出；reason 自由文本放 properties 首位
// （mini-CoT）；enum 类不放首位；reason 用 pattern 限长（不用 maxLength）；
// required 全列；可空字段 anyOf null；fetchImpl 箭头包装（浏览器原生 this 敏感）；
// 返回含 <think> 前缀时剥离再解析；单次超时 60s、失败退避重试一次、沿用上次决策。

import {
  MINIMAX_SYSTEM_PROMPT,
  extractFirstJsonObject,
  normalizeEcologySnapshot,
  normalizeWorldPlan,
} from './client.js';
import { MASTER_SYSTEM_PROMPT, normalizeMasterInput } from '../master/llm-master.js';
import { normalizeMasterDecision, tensionRange } from '../master/policy.js';
import { MIN_DAY_PLAN_TIMEOUT_MS } from './scheduler.js';

export const BIRD_AGENT_MODEL = 'bird_agent';
export const REASON_PATTERN = '^[\\u4e00-\\u9fa50-9\\uff0c\\u3002\\u3001\\uff1b\\uff1a]{4,30}$';
// 在线复验正常完整响应最坏约 316 token；512 留出约 60% 余量，结构尾部偶发截断再由
// 保守 salvage 补闭合符，避免空白 runaway 白耗 1536 token 并挤占调度预算。
export const FLOCK_MAX_TOKENS = 512;
export const MASTER_MAX_TOKENS = 512;
const ESTIMATED_TOKENS_PER_SECOND = 40;
const REASON_MAX_CHARS = 30;
const MASTER_SEASON_GUARD = '强制季节约束：只读 flags.seasonFinal；仅 seasonFinal=true 时 nextSeason 与 seasonLength 可为非 null，seasonFinal=false 时二者都输出 null，否则整份决策会被拒绝。不要自行比较 seasonDay 与 seasonLength。';

// flock 日计划：形状对齐 normalizeWorldPlan 契约，per-flock reason 首位（mini-CoT）。
export const FLOCK_PLAN_SCHEMA = Object.freeze({
  name: 'flock_day_plan',
  schema: {
    type: 'object',
    properties: {
      flocks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            reason: { type: 'string', pattern: REASON_PATTERN },
            dwellBeats: { type: 'number' },
            activeBars: { type: 'number' },
            holdLoops: { type: 'integer' },
            mutations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'integer' },
                  to: { type: 'integer' },
                },
                required: ['from', 'to'],
                additionalProperties: false,
              },
            },
            cellMutations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: {
                    type: 'object',
                    properties: {
                      pitchBranchId: { type: 'integer' },
                      stepIndex: { type: 'integer' },
                    },
                    required: ['pitchBranchId', 'stepIndex'],
                    additionalProperties: false,
                  },
                  to: {
                    type: 'object',
                    properties: {
                      pitchBranchId: { type: 'integer' },
                      stepIndex: { type: 'integer' },
                    },
                    required: ['pitchBranchId', 'stepIndex'],
                    additionalProperties: false,
                  },
                },
                required: ['from', 'to'],
                additionalProperties: false,
              },
            },
          },
          required: ['reason', 'dwellBeats', 'activeBars', 'holdLoops', 'mutations', 'cellMutations'],
          additionalProperties: false,
        },
      },
      master: {
        type: 'object',
        properties: { ops: { type: 'array', items: { type: 'object' } } },
        required: ['ops'],
        additionalProperties: false,
      },
    },
    required: ['flocks', 'master'],
    additionalProperties: false,
  },
});

// master 决策：形状对齐 normalizeMasterDecision 契约；换季字段可空（anyOf null）。
export const MASTER_DECISION_SCHEMA = Object.freeze({
  name: 'master_decision',
  schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', pattern: REASON_PATTERN },
      colorId: { type: 'string' },
      tension: { type: 'number', minimum: 0, maximum: 1 },
      nextSeason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      seasonLength: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
    required: ['reason', 'colorId', 'tension', 'nextSeason', 'seasonLength'],
    additionalProperties: false,
  },
});

function stringMenu(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

/**
 * 把 master 输入中已经白名单化的当季菜单下沉到 guided-decoding schema。
 * 缺菜单时保留旧自由 string，绝不生成 enum:[]（它会令所有输出不可满足）。
 */
export function buildMasterDecisionSchema(normalizedInput = {}) {
  const season = normalizedInput?.state?.season;
  const colors = stringMenu(normalizedInput?.menu?.colorsBySeason?.[season]);
  const seasons = stringMenu(normalizedInput?.menu?.seasons);
  const [tensionMinimum, tensionMaximum] = tensionRange(normalizedInput?.menu);
  return {
    name: MASTER_DECISION_SCHEMA.name,
    schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', pattern: REASON_PATTERN },
        colorId: colors.length ? { type: 'string', enum: colors } : { type: 'string' },
        tension: { type: 'number', minimum: tensionMinimum, maximum: tensionMaximum },
        nextSeason: {
          anyOf: [
            seasons.length ? { type: 'string', enum: seasons } : { type: 'string' },
            { type: 'null' },
          ],
        },
        seasonLength: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
      required: ['reason', 'colorId', 'tension', 'nextSeason', 'seasonLength'],
      additionalProperties: false,
    },
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function stripStructuredWrappers(content) {
  let cleaned = content.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  // 兼容旧服务偶发的 Markdown JSON 围栏；缺尾围栏也允许进入后续保守补全。
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trimEnd();
  return cleaned;
}

// 仅补 JSON 的结构闭合符，不猜字段、值或半个 escape/literal；最终仍须经过既有 normalize 校验。
function salvageTruncatedJson(candidate) {
  const source = candidate.trimEnd();
  if (!source) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null;
    }
  }
  // 尾部反斜杠代表半个 escape，含义不明确，不能擅自补救。
  if (escaped || (!inString && stack.length === 0)) return null;
  const repaired = `${source}${inString ? '"' : ''}${stack.reverse().join('')}`;
  try { return JSON.parse(repaired); } catch { return null; }
}

// 结构化输出下不应有思考段；若上游仍夹带 think/围栏则先剥离。完整 JSON 与既有
// 平衡对象提取均失败后，才对尾部截断尝试只补引号/括号的保守 salvage。
export function parseStructuredContent(content) {
  if (typeof content !== 'string') return null;
  const cleaned = stripStructuredWrappers(content);
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch {
    const extracted = extractFirstJsonObject(cleaned);
    if (extracted) return extracted;
    const starts = [cleaned];
    const objectStart = cleaned.indexOf('{');
    if (objectStart > 0) starts.push(cleaned.slice(objectStart));
    const arrayStart = cleaned.indexOf('[');
    if (arrayStart > 0) starts.push(cleaned.slice(arrayStart));
    for (const candidate of starts) {
      const salvaged = salvageTruncatedJson(candidate);
      if (salvaged) return salvaged;
    }
    return null;
  }
}

// 部分 OpenAI 兼容服务会接受 json_schema 却忽略 string pattern；此处只收敛自由文本，
// 不改变任何数值/菜单字段。按 Unicode 字符截到 30 字，避免合法整包因啰嗦 reason 被丢弃。
export function clampStructuredReasons(parsed, schema) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const clampReason = (value) => typeof value === 'string'
    ? Array.from(value.replace(/[\r\n]+/g, ' ').trim()).slice(0, REASON_MAX_CHARS).join('')
    : value;
  if (schema?.name === FLOCK_PLAN_SCHEMA.name && Array.isArray(parsed.flocks)) {
    for (const flock of parsed.flocks) flock.reason = clampReason(flock?.reason);
  } else if (schema?.name === MASTER_DECISION_SCHEMA.name) {
    parsed.reason = clampReason(parsed.reason);
  }
  return parsed;
}

export class BirdAgentClient {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    model = BIRD_AGENT_MODEL,
    timeoutMs = 60000,
    retryDelayMs = 3000,
  } = {}) {
    if (!baseUrl) throw new Error('BirdAgentClient: baseUrl is required');
    if (typeof fetchImpl !== 'function') throw new Error('BirdAgentClient: fetch implementation is required');
    // 浏览器原生 fetch this 敏感（同 MinimaxClient 的前车之鉴）：统一脱敏。
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 60000);
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this.lastFlockPlan = null;
    this.lastMasterDecision = null;
  }

  /**
   * 健康检查：GET /v1/models，healthTimeoutMs 内非 200/异常/超时一律视为离线
   * （调用方静默回落 MiniMax/规则）。任何探测失败都绝不能阻塞应用启动（T19）。
   */
  async checkHealth({ timeoutMs = 3000 } = {}) {
    const budget = Math.max(1, Number(timeoutMs) || 3000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        signal: controller.signal,
      });
      return !!response?.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async post(body, { signal } = {}) {
    const controller = new AbortController();
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response?.ok) return null;
      const data = await response.json();
      return parseStructuredContent(data?.choices?.[0]?.message?.content);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 失败退避重试一次（文档 §6：幂等，指数退避；此处对齐「重试一次」约定）。
  async chat(systemPrompt, user, schema, options) {
    const maxTokens = schema?.name === FLOCK_PLAN_SCHEMA.name
      ? FLOCK_MAX_TOKENS : MASTER_MAX_TOKENS;
    const requestedSchedulerBudgetMs = Number(options?.schedulerBudgetMs);
    if (Number.isFinite(requestedSchedulerBudgetMs) && requestedSchedulerBudgetMs > 0) {
      const schedulerBudgetMs = Math.max(MIN_DAY_PLAN_TIMEOUT_MS, requestedSchedulerBudgetMs);
      const estimatedWorstMs = Math.round((maxTokens / ESTIMATED_TOKENS_PER_SECOND) * 1000);
      console.debug('bird_agent request timing', {
        schema: schema?.name ?? 'unknown',
        maxTokens,
        estimatedWorstMs,
        schedulerBudgetMs,
        withinBudget: estimatedWorstMs <= schedulerBudgetMs,
      });
    }
    const body = {
      model: this.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: schema },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0 && this.retryDelayMs > 0) await sleep(this.retryDelayMs);
      const parsed = await this.post(body, options);
      if (parsed) return clampStructuredReasons(parsed, schema);
    }
    return null;
  }

  /** flock 日计划：输入沿用 normalizeEcologySnapshot 白名单（含生态 frame 四字段）。 */
  async requestDayPlan(snapshot, options) {
    const ecology = normalizeEcologySnapshot(snapshot);
    const parsed = await this.chat(
      MINIMAX_SYSTEM_PROMPT, JSON.stringify(ecology), FLOCK_PLAN_SCHEMA, options);
    const plan = parsed
      ? normalizeWorldPlan(
        parsed,
        ecology.flocks.length,
        ecology.flocks.map((flock) => flock.menu),
        ecology.flocks.map((flock) => flock.sequencePattern),
      )
      : null;
    if (plan) {
      this.lastFlockPlan = plan;
      return plan;
    }
    return this.lastFlockPlan; // 失败沿用上次决策（文档 §6）；无历史即 null → 上层落 MiniMax
  }

  /** master 决策：输入沿用 normalizeMasterInput，输出沿用 normalizeMasterDecision 校验。 */
  async requestDecision(input = {}, options) {
    const normalized = normalizeMasterInput(input);
    const schema = buildMasterDecisionSchema(normalized);
    const parsed = await this.chat(
      `${MASTER_SYSTEM_PROMPT}\n${MASTER_SEASON_GUARD}`,
      JSON.stringify(normalized), schema, options);
    const decision = parsed ? normalizeMasterDecision(parsed, input.menu, input.state) : null;
    if (decision) {
      this.lastMasterDecision = decision;
      return decision;
    }
    return this.lastMasterDecision;
  }
}

export function createBirdAgentClient(options) {
  return new BirdAgentClient(options);
}
