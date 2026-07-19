import { normalizeMasterDecision } from './policy.js';
import { normalizeMasterInput } from './llm-master.js';

const ACTIONS = new Set(['advanceStep', 'jumpToStep', 'changeSeason', 'nextPalette']);

function cleanReason(value) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : '';
}

// 把玮圣服务的 action/params 外壳收敛为项目既有 master 契约；最终菜单、
// 冷却期和“一次只改一维”约束仍统一交给 normalizeMasterDecision 校验。
export function normalizeExternalDecision(raw, menu = {}, state = {}) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.has(raw.action)) return null;
  const params = raw.params == null ? {} : raw.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const reason = cleanReason(raw.reason);
  if (!reason) return null;

  let candidate;
  if (raw.action === 'advanceStep') {
    if (Object.keys(params).length) return null;
    candidate = { advanceStep: true, reason };
  } else if (raw.action === 'jumpToStep') {
    if (Object.keys(params).some((key) => !['step', 'jumpToStep'].includes(key))) return null;
    candidate = {
      advanceStep: false,
      jumpToStep: params.step ?? params.jumpToStep,
      reason,
    };
  } else {
    const allowed = raw.action === 'nextPalette'
      ? ['season', 'palette', 'nextPalette']
      : ['season', 'changeSeason', 'palette', 'nextPalette'];
    if (Object.keys(params).some((key) => !allowed.includes(key))) return null;
    const season = raw.action === 'nextPalette'
      ? (params.season ?? state.currentSeason)
      : (params.season ?? params.changeSeason);
    candidate = {
      advanceStep: false,
      changeSeason: season,
      nextPalette: params.palette ?? params.nextPalette,
      reason,
    };
  }
  return normalizeMasterDecision(candidate, menu, state);
}

export function createExternalMaster({
  endpoint,
  headers = {},
  timeoutMs = 3000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = typeof endpoint === 'string' ? endpoint.trim() : '';

  return Object.freeze({
    async requestDecision(masterInput = {}) {
      if (!url || typeof fetchImpl !== 'function') return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(0, Number(timeoutMs) || 0));
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(normalizeMasterInput(masterInput)),
        });
        if (!response?.ok) return null;
        const raw = await response.json();
        return normalizeExternalDecision(raw, masterInput.menu, masterInput.state);
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

function callable(source) {
  if (typeof source === 'function') return source;
  if (typeof source?.requestDecision === 'function') return source.requestDecision.bind(source);
  return null;
}

// 决策优先级固定为 external → llm → policy。组合器只提供接口位，主循环接线另行完成。
// WithSource 额外返回命中来源，供日志/时间线穿透展示；旧 resolveMasterDecision
// 只返回决策本身，行为不变。
export async function resolveMasterDecisionWithSource({ external, llm, policy } = {}, masterInput = {}) {
  const layers = [['external', external], ['llm', llm]];
  for (const [name, source] of layers) {
    const decide = callable(source);
    if (!decide) continue;
    try {
      const decision = await decide(masterInput);
      const normalized = normalizeMasterDecision(decision, masterInput.menu, masterInput.state);
      if (normalized) return { decision: normalized, source: name };
    } catch {
      // 一个异步来源失败时继续尝试下一层。
    }
  }
  const fallback = callable(policy);
  if (!fallback) return { decision: null, source: null };
  try {
    const decision = fallback(masterInput) ?? null;
    return { decision, source: decision ? 'policy' : null };
  } catch {
    return { decision: null, source: null };
  }
}

export async function resolveMasterDecision(sources = {}, masterInput = {}) {
  const { decision } = await resolveMasterDecisionWithSource(sources, masterInput);
  return decision;
}
