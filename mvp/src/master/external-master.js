import { normalizeMasterDecision } from './policy.js';

function callable(source) {
  if (typeof source === 'function') return source;
  if (typeof source?.requestDecision === 'function') return source.requestDecision.bind(source);
  return null;
}

// 决策优先级固定为 llm（bird_agent → MiniMax）→ policy。
// WithSource 额外返回命中来源，供日志/时间线穿透展示；旧 resolveMasterDecision
// 只返回决策本身，行为不变。
export async function resolveMasterDecisionWithSource({ llm, policy } = {}, masterInput = {}) {
  const decide = callable(llm);
  if (decide) {
    try {
      const decision = await decide(masterInput);
      const normalized = normalizeMasterDecision(decision, masterInput.menu, masterInput.state);
      if (normalized) return { decision: normalized, source: 'llm' };
    } catch {
      // 异步来源失败时继续同步规则兜底。
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
