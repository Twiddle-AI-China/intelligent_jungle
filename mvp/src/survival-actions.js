// Master 只从有限策略菜单选方向；数值结算仍由 survival loop 根据真实行为完成。
// 策略改变资源转换预算与音色探索驱动力，不直接改写音乐密度、驻留或 activeBars。

export const SURVIVAL_ACTION_IDS = Object.freeze(['rest', 'perch', 'explore', 'balance']);
export const SURVIVAL_MOODS = Object.freeze(['steady', 'protective', 'curious', 'restless']);

const ACTIONS = Object.freeze({
  rest: Object.freeze({
    id: 'rest', label: '休整', latentDrive: 0.35,
    suggestions: Object.freeze([]),
  }),
  perch: Object.freeze({
    id: 'perch', label: '栖枝', latentDrive: 0.55,
    suggestions: Object.freeze([]),
  }),
  explore: Object.freeze({
    id: 'explore', label: '探索', latentDrive: 3,
    suggestions: Object.freeze([]),
  }),
  balance: Object.freeze({
    id: 'balance', label: '平衡', latentDrive: 1,
    suggestions: Object.freeze([]),
  }),
});

const valueOf = (survival, key) => {
  const value = Number(survival?.[key]?.value);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 60;
};

export function survivalMoodForDay(day = 0, treeId = '') {
  let hash = (2166136261 ^ Math.imul(Math.trunc(Number(day) || 0), 0x9e3779b1)) >>> 0;
  for (const char of String(treeId)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return SURVIVAL_MOODS[(hash >>> 0) % SURVIVAL_MOODS.length];
}

export function legalSurvivalActionIds(survival = {}) {
  const health = valueOf(survival, 'health');
  const stamina = valueOf(survival, 'stamina');
  const food = valueOf(survival, 'food');
  const ids = ['rest'];
  if (health > 20) ids.push('perch');
  if (stamina > 20 && food < 90) ids.push('explore');
  if (health > 25 && stamina > 25) ids.push('balance');
  return Object.freeze(ids);
}

export function normalizeSurvivalAction(action, survival = {}) {
  const id = typeof action === 'string' ? action : action?.id;
  return legalSurvivalActionIds(survival).includes(id) ? ACTIONS[id] : null;
}

/**
 * 资源安全线永远先于 mood。mood 只在安全区改变同样合法的日策略，形成可复现
 * 的 Master 性格波动；未来接 LLM 时也只能返回同一 action id。
 */
export function decideSurvivalAction(survival = {}, { mood = 'steady' } = {}) {
  const health = valueOf(survival, 'health');
  const stamina = valueOf(survival, 'stamina');
  const food = valueOf(survival, 'food');
  const safeMood = SURVIVAL_MOODS.includes(mood) ? mood : 'steady';
  let id = 'balance';
  let reason = '三项资源稳定，维持循环';

  if (health <= 25) {
    id = 'rest'; reason = `生命 ${health.toFixed(0)}，停止额外消耗`;
  } else if (stamina <= 25) {
    id = 'perch'; reason = `体力 ${stamina.toFixed(0)}，优先栖枝恢复`;
  } else if (food <= 30) {
    id = 'explore'; reason = `食物 ${food.toFixed(0)}，优先探索补充`;
  } else if (health < 42) {
    id = 'rest'; reason = `生命 ${health.toFixed(0)}，提前休整`;
  } else if (stamina < 42) {
    id = 'perch'; reason = `体力 ${stamina.toFixed(0)}，提前栖枝`;
  } else if (food < 48) {
    id = 'explore'; reason = `食物 ${food.toFixed(0)}，扩大探索`;
  } else if (safeMood === 'protective' && health < 65) {
    id = 'rest'; reason = `Master 今日谨慎，生命 ${health.toFixed(0)} 时休整`;
  } else if (safeMood === 'curious' && stamina > 45 && food < 85) {
    id = 'explore'; reason = `Master 今日好奇，主动扩大音色探索`;
  } else if (safeMood === 'restless' && health > 45) {
    id = 'perch'; reason = `Master 今日躁动，增加树枝活动`;
  }

  const action = normalizeSurvivalAction(id, survival) ?? ACTIONS.rest;
  return Object.freeze({
    ...action,
    reason,
    mood: safeMood,
    legalIds: legalSurvivalActionIds(survival),
  });
}
