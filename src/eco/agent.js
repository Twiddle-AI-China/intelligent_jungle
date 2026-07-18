// 种群 agent 的确定性兜底策略（设计 v3.3 §6.2，G7 韧性）。
// 5 条生存规则用纯代码实现：LLM 是「个性层」，掉线时代码无缝接管，循环永不停。
// 每条规则只引用生态词汇（栖/飞/energy/树健康/虫害/邻树活动），输出 dwellUrge 与目标——
// agent 的世界里没有「音」这个字。

import { SPECIES } from '../world.js';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// 规则输出：每个 flock 的 dwellUrge（归栖倾向）。
// 这是确定性的「基底行为」，LLM 在其上做倾向与时机调整。
export function flockPolicy(world, flock) {
  const tree = world.trees[flock.homeTreeId];
  const daylight = 0.5 + 0.5 * Math.cos((world.dayPhase - 0.25) * Math.PI * 2);
  const species = SPECIES.find((s) => s.id === flock.speciesId) ?? SPECIES[0];
  // 规则 1 作息：夜间归栖（dwellUrge 高），白天活跃。
  let dwellUrge = clamp(species.dwellBias * (1.4 - daylight));
  // 规则 2 体力：energy 低 → 归栖休息；充沛 → 活跃起飞。
  if (flock.energy < 0.35) dwellUrge = clamp(dwellUrge + 0.3);
  if (flock.energy > 0.8) dwellUrge = clamp(dwellUrge - 0.2);
  // 规则 3 本职：按物种职能微调。
  if (species.id === 'pelican') {
    // 压枝自限：己树健康不足时节制停驻（bass 的克制是生态自限）。
    if (tree.foliage < 0.45) dwellUrge = clamp(dwellUrge - 0.35);
  } else if (species.id === 'woodpecker') {
    // 啄虫：己树有虫时多停驻清理（串门先不做）。
    if (tree.pest > 0.08) dwellUrge = clamp(dwellUrge + 0.25);
  } else if (species.id === 'dove') {
    // 择弱树久栖沃土：若己树最弱则更高 dwellUrge。
    const weakest = world.trees.reduce((w, t) => (t.foliage < (w?.foliage ?? 2) ? t : w), null);
    if (weakest && weakest.id === flock.homeTreeId && weakest.foliage < 0.6) dwellUrge = clamp(dwellUrge + 0.25);
  } else if (species.id === 'lark') {
    // 传粉：定期巡飞（低 dwellUrge，多飞）。
    dwellUrge = clamp(dwellUrge * 0.6);
  }
  // 规则 4 应答：邻树近期起落频繁 → 短暂跟随兴奋（降 dwellUrge）。
  const neighbors = world.flocks.filter((f) => f.id !== flock.id);
  const neighborActivity = neighbors.length ? neighbors.reduce((s, f) => s + f.meanSpeed, 0) / neighbors.length : 0;
  if (neighborActivity > world.config.maxSpeed * 0.55) dwellUrge = clamp(dwellUrge - 0.15);
  // 规则 5 兜底 cruise：上面都没触发时维持物种基线。
  return { dwellUrge };
}

// Master 的中度干扰目标：健康保持带内 + 对「过稳」惩罚（v3.3 §6.3）。
// 返回本周期 master 的环境操作列表。扰动限速：强度上限 + 冷却（bars）。
export function masterPolicy(world, health, stagnationLevel, cooldownBars) {
  const ops = [];
  // 健康偏离带 → 纠正（换季/补鸟）。
  if (health.min < 0.3) {
    const weakest = world.trees.reduce((w, t) => (t.foliage < (w?.foliage ?? 2) ? t : w), null);
    if (weakest) ops.push({ type: 'set_population', flock: weakest.id, delta: +1 });
  }
  if (health.mean < 0.45) ops.push({ type: 'set_scale', mode: 'major' }); // 换季提振
  // 过稳 → 扰动（限速：强度封顶 0.25，冷却期内不再注入）。
  if (stagnationLevel > 0.7 && cooldownBars <= 0) {
    const target = Math.floor(Math.random() * world.trees.length);
    ops.push({ type: 'spawn_pest_wave', tree: target, intensity: 0.25 });
  }
  return ops;
}
