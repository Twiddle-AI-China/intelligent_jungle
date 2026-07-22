// Master 生存行动菜单：只允许从有限动作中选择，数值 delta 仍由确定性
// survival ledger 结算。这里不接受模型自定义参数，也不直接写 world。

export const SURVIVAL_ACTION_IDS = Object.freeze(['hold', 'rest', 'recover', 'forage']);

const ACTIONS = Object.freeze({
  hold: Object.freeze({ id: 'hold', label: '观察', suggestions: Object.freeze([]) }),
  rest: Object.freeze({
    id: 'rest', label: '休息',
    suggestions: Object.freeze([
      Object.freeze({ dimension: 'density', delta: -1, reason: '体力偏低·休息' }),
      Object.freeze({ dimension: 'activeBars', delta: -1, reason: '体力偏低·缩短活动' }),
    ]),
  }),
  recover: Object.freeze({
    id: 'recover', label: '恢复',
    suggestions: Object.freeze([
      Object.freeze({ dimension: 'dwell', delta: +1, reason: '生命偏低·延长休养' }),
      Object.freeze({ dimension: 'activeBars', delta: -1, reason: '生命偏低·减少消耗' }),
    ]),
  }),
  forage: Object.freeze({
    id: 'forage', label: '觅食',
    suggestions: Object.freeze([
      Object.freeze({ dimension: 'density', delta: +1, reason: '捕获偏低·增加觅食' }),
      Object.freeze({ dimension: 'activeBars', delta: +1, reason: '捕获偏低·延长活动' }),
    ]),
  }),
});

const valueOf = (survival, key) => {
  const value = Number(survival?.[key]?.value);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 60;
};

export function legalSurvivalActionIds(survival = {}) {
  const stamina = valueOf(survival, 'stamina');
  const health = valueOf(survival, 'health');
  const catchValue = valueOf(survival, 'catch');
  const ids = ['hold'];
  if (stamina < 60) ids.push('rest');
  if (health < 60) ids.push('recover');
  // 生命或体力已危险时禁止 Master 继续加活动量。
  if (catchValue < 75 && stamina > 25 && health > 25) ids.push('forage');
  return Object.freeze(ids);
}
export function normalizeSurvivalAction(action, survival = {}) {
  const id = typeof action === 'string' ? action : action?.id;
  return legalSurvivalActionIds(survival).includes(id) ? ACTIONS[id] : null;
}

/**
 * 确定性 Master policy。mood 只能在安全菜单内打破非关键状态的平局；
 * 生命/体力硬护栏永远优先，LLM 后续也只能返回同一 action id。
 */
export function decideSurvivalAction(survival = {}, { mood = 'steady' } = {}) {
  const stamina = valueOf(survival, 'stamina');
  const health = valueOf(survival, 'health');
  const catchValue = valueOf(survival, 'catch');
  let id = 'hold';
  let reason = '三项资源稳定，继续观察';

  if (health <= 20) {
    id = 'recover'; reason = `生命值 ${health.toFixed(0)}，优先恢复`;
  } else if (stamina <= 20) {
    id = 'rest'; reason = `体力值 ${stamina.toFixed(0)}，优先休息`;
  } else if (health < 35) {
    id = 'recover'; reason = `生命值 ${health.toFixed(0)}，进入恢复`;
  } else if (stamina < 35) {
    id = 'rest'; reason = `体力值 ${stamina.toFixed(0)}，进入休息`;
  } else if (catchValue < 35 && stamina > 25 && health > 25) {
    id = 'forage'; reason = `捕获量 ${catchValue.toFixed(0)}，增加觅食`;
  } else if (mood === 'protective' && health < 55) {
    id = 'recover'; reason = `Master 偏保守，生命值 ${health.toFixed(0)} 时提前恢复`;
  } else if (mood === 'restless' && catchValue < 55 && stamina > 40 && health > 40) {
    id = 'forage'; reason = `Master 偏躁动，捕获量 ${catchValue.toFixed(0)} 时提前觅食`;
  }

  const action = normalizeSurvivalAction(id, survival) ?? ACTIONS.hold;
  return Object.freeze({
    ...action,
    reason,
    mood: ['steady', 'protective', 'restless'].includes(mood) ? mood : 'steady',
    legalIds: legalSurvivalActionIds(survival),
  });
}
