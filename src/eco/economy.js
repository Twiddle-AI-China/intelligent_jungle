// 树健康经济（设计 v3.3 §6.1）：每棵树的健康是五个流量的积分。
// 纯生态词汇——进：沃土/传粉/休养；出：虫害/压枝/过载。agent 的规则只引用这些量。

import { SPECIES } from '../world.js';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// 速率常数：一个「无人干预时四树缓慢波动但不崩」的基线。开放问题 §9.2 用数值原型标定。
export const ECONOMY = Object.freeze({
  doveSoilRate: 0.010,      // 斑鸠沃土：每只安栖斑鸠/秒
  larkPollenRate: 0.006,    // 百灵传粉：每次穿飞经过/树
  restRate: 0.012,          // 休养：低占用自愈/秒（夜间 ×2）
  pestBaseRate: 0.004,      // 虫害滋生/秒（随季节变速）
  pestSeasonScale: [0.4, 1.6, 1.0, 0.5], // 春夏秋冬
  pelicanLoadRate: 0.0025,  // 鹈鹕压枝：每只停驻鹈鹕/秒（低音的克制是自限，不是速死）
  overloadRate: 0.010,      // 过载：超出容量每只/秒
  crowdingRate: 0.004,      // 郁闭：占用超 60% 的损耗系数
  woodpeckerClearRate: 0.020, // 啄木鸟啄虫：每只出诊啄木鸟/秒
  foliageDecayOnPest: 0.6,  // 虫害对繁茂度的连带损耗系数
  restOccupancyCap: 0.3,    // 低于此占用才自愈
});

// 每个物种一个职能动词。
export const VERB = Object.freeze({
  pelican: 'load',       // 压枝（开销）
  dove: 'soil',          // 沃土（进项）
  lark: 'pollinate',     // 传粉（进项）
  woodpecker: 'clear',   // 啄虫（防御）
});

// 计算一棵树的瞬时流量。输入全部来自 world 的可视状态。
export function treeFlows(world, tree) {
  const occupancy = world._occupancy ?? [];
  const perchedHere = world.boids.filter((b) => b.perched && b.perched.treeId === tree.id);
  const flying = world.boids.filter((b) => !b.perched);
  let inflow = 0; let outflow = 0; let pestGrowth = 0; let pestClear = 0;
  const daylight = 0.5 + 0.5 * Math.cos((world.dayPhase - 0.25) * Math.PI * 2);
  for (const boid of perchedHere) {
    const species = SPECIES.find((s) => s.id === world.flocks[boid.flockId]?.speciesId);
    if (!species) continue;
    if (species.id === 'dove') inflow += ECONOMY.doveSoilRate;
    if (species.id === 'pelican') outflow += ECONOMY.pelicanLoadRate;
    if (species.id === 'woodpecker') pestClear += ECONOMY.woodpeckerClearRate;
  }
  // 百灵穿飞：己树飞鸟在树冠附近即传粉（近似：百灵群飞鸟数 × 小系数）。
  const larkFlock = world.flocks.find((f) => f.speciesId === 'lark');
  const larkFlying = flying.filter((b) => world.flocks[b.flockId]?.speciesId === 'lark').length;
  inflow += larkFlying * ECONOMY.larkPollenRate * 0.2;
  // 休养：占用未满即自愈（空树休养最快），夜间加速。
  const occupancyRatio = perchedHere.length / Math.max(1, world.flocks.find((f) => f.homeTreeId === tree.id)?.population ?? 1);
  inflow += ECONOMY.restRate * (1 - occupancyRatio) * (1 + (1 - daylight));
  // 过载：占用超容量损耗（>1 时；高占用的调节是 agent 的活，物理不强制）。
  if (occupancyRatio > 1) outflow += (occupancyRatio - 1) * ECONOMY.overloadRate;
  // 虫害滋生：随季节变速。
  pestGrowth = ECONOMY.pestBaseRate * (ECONOMY.pestSeasonScale[world.season] ?? 1);
  return { inflow, outflow, pestGrowth, pestClear, daylight, occupancyRatio };
}

// 推进一棵树的生态经济一个 dt。返回更新后的 {foliage, pest}。
export function stepTreeEconomy(world, tree, dt) {
  const flows = treeFlows(world, tree);
  // 虫害动态：滋生 - 啄虫清除。
  tree.pest = clamp(tree.pest + (flows.pestGrowth - flows.pestClear) * dt);
  // 健康：净流入 - 虫害连带损耗（虫害是主导威胁，系数要让它可感）。
  const net = flows.inflow - flows.outflow - tree.pest * ECONOMY.foliageDecayOnPest * 0.05;
  tree.foliage = clamp(tree.foliage + net * dt);
  return { foliage: tree.foliage, pest: tree.pest, flows };
}

export function stepEconomy(world, dt) {
  world._occupancy = world._occupancy ?? null;
  for (const tree of world.trees) stepTreeEconomy(world, tree, dt);
}

// Master 扰动工具：向某树注入一波虫害（有上限，与自然滋生叠加）。
export function spawnPestWave(world, treeId, intensity = 0.3) {
  const tree = world.trees[treeId];
  if (!tree) return false;
  tree.pest = clamp(tree.pest + clamp(intensity, 0, 0.5));
  return true;
}

// 全局健康与「过稳」判据（master 中度干扰目标的输入）。
export function ecosystemHealth(world) {
  const foliage = world.trees.map((t) => t.foliage);
  const mean = foliage.reduce((a, b) => a + b, 0) / Math.max(1, foliage.length);
  return { mean, min: Math.min(...foliage), perTree: foliage };
}

// 「过稳」：返回 0-1，越高越单调。用各 flock 活跃度的近期方差的倒数近似。
export function stagnation(world, windowSeconds = 16) {
  // 简化：用当前栖飞比的接近满/空程度估计单调性。
  const ratios = world.flocks.map((f) => f.population ? f.perchedCount / f.population : 0);
  const extremes = ratios.filter((r) => r < 0.05 || r > 0.95).length;
  return extremes / Math.max(1, ratios.length);
}
