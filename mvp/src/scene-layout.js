// mvp/src/scene-layout.js —— 单树纵向世界坐标与相机（纯函数，无 DOM/Canvas 依赖）。
// 规格：docs/single-tree-ui-design-2026-07-21.md §3/§4/§6 Worker A。
// 视觉一棵树、逻辑四 treeId：四个声部带纵向堆叠（上→下 pad/melody/bass/texture），
// 枝群单侧且左右交替；所有位置先算世界坐标，再以 screenY = worldY - viewportY 投影。

import { CONFIG } from './config.js';

const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0; value = (value + 0x6D2B79F5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

// 声部带顺序（世界 Y 升序 = 自上而下）与枝群方向（1=右侧，-1=左侧）。
export const VOICE_ORDER = Object.freeze(['pad', 'melody', 'bass', 'texture']);
const SIDE_BY_ID = { pad: 1, melody: -1, bass: 1, texture: -1 };
// 枝群横向跨度基准（占画布宽）：pad 长枝 / melody 短枝 / bass 主枝 / texture 不规则短枝。
const SPAN_BY_SPECIES = { pad: 0.30, melody: 0.16, bass: 0.26, texture: 0.15 };

// 年轮控件：键名与 audio 混音参数（MIX_PARAM_SPECS / main.js RING_KEYS）对齐。
// eq* 为 ±12dB 搁架；reverbSend 0..1；gain 0..2。
export const RING_RANGES = Object.freeze({
  eqLowDb: Object.freeze([-12, 12]),
  eqMidDb: Object.freeze([-12, 12]),
  eqHighDb: Object.freeze([-12, 12]),
  reverbSend: Object.freeze([0, 1]),
  gain: Object.freeze([0, 2]),
});
export const RING_LABELS = Object.freeze({
  eqLowDb: 'EQ 低', eqMidDb: 'EQ 中', eqHighDb: 'EQ 高', reverbSend: 'FX · Reverb', gain: 'Volume',
});

// ---- 世界度量：带高 ≈ 视口高，上下各留半屏边距使四个声部都能吸附居中 ----
export function computeWorldMetrics(height) {
  const bandHeight = Math.max(height * 0.92, 360);
  const margin = Math.max(height * 0.5, 120);
  const worldHeight = margin * 2 + bandHeight * VOICE_ORDER.length;
  return { bandHeight, margin, worldHeight };
}

export function clampViewportY(viewportY, height) {
  const { worldHeight } = computeWorldMetrics(height);
  const max = Math.max(0, worldHeight - height);
  const value = Number(viewportY);
  return clamp(Number.isFinite(value) ? value : 0, 0, max);
}

export function voiceCenterWorldY(treeId, height) {
  const index = VOICE_ORDER.indexOf(treeId);
  if (index < 0) return null;
  const { bandHeight, margin } = computeWorldMetrics(height);
  return margin + bandHeight * (index + 0.5);
}

// 吸附目标：让该声部带中心落在视口中心（边界处由 clamp 兜底）。
export function focusViewportY(treeId, height) {
  const center = voiceCenterWorldY(treeId, height);
  if (center == null) return 0;
  return clampViewportY(center - height / 2, height);
}

// 视口中心最近的声部 = 当前可见声部。
export function visibleVoiceAt(viewportY, height) {
  const center = clampViewportY(viewportY, height) + height / 2;
  let best = VOICE_ORDER[0];
  let bestDist = Infinity;
  for (const id of VOICE_ORDER) {
    const dist = Math.abs(voiceCenterWorldY(id, height) - center);
    if (dist < bestDist) { bestDist = dist; best = id; }
  }
  return best;
}

// 单树场景布局：每声部一个带（band），返回屏幕坐标（已投影），并保留世界坐标字段。
// trees 元素为 snapshot tree 与 config tree 的合并（同 computeTreeLayout 的 layoutInput）。
export function computeSceneLayout(trees, width, height, { viewportY = 0, focusTreeId = null } = {}) {
  const { bandHeight, margin } = computeWorldMetrics(height);
  const vY = clampViewportY(viewportY, height);
  const trunkX = width * 0.5;
  const byId = Object.fromEntries((trees ?? []).map((tree) => [tree.id, tree]));

  return VOICE_ORDER.map((id, index) => byId[id] && { tree: byId[id], index })
    .filter(Boolean)
    .map(({ tree, index }) => {
      const species = tree.species ?? tree.id;
      const side = SIDE_BY_ID[tree.id] ?? (tree.mirror ? -1 : 1);
      const bandTop = margin + bandHeight * index;
      const worldY = bandTop + bandHeight / 2;
      const cellY = bandTop - vY;
      const seed = [...tree.id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7);
      const rng = mulberry32(seed);
      const baseSpan = SPAN_BY_SPECIES[species] ?? 0.2;

      // 五层单侧枝：branchId 0=最低枝（低音）→4=最高枝；texture 带确定性抖动（不规则短枝）。
      const branchPoints = [];
      for (let branchId = 0; branchId < 5; branchId += 1) {
        const jitter = species === 'texture' ? (rng() - 0.5) * 0.05 : 0;
        const relY = 0.70 - branchId * 0.125 + jitter;
        const spanScale = species === 'texture' ? 0.72 + rng() * 0.55 : 0.92 + rng() * 0.16;
        const span = width * baseSpan * spanScale;
        branchPoints.push({
          branchId,
          isRunner: false,
          x: trunkX + side * span * 0.5,
          y: bandTop + relY * bandHeight - vY,
          span,
        });
      }

      // Bass runner：单侧主枝承载五节点（西→东），branchId 保持 5..9。
      // 有 runnerAnchors 时沿用其图片归一化 x（同 legacy computeTreeLayout 的映射，
      // 只是参照系从贴图矩形换为「树干→枝梢」的带内区间）；无锚点时退回等距兜底。
      const runnerAnchors = Array.isArray(tree.runnerAnchors) ? tree.runnerAnchors : null;
      const runnerBranches = Array.isArray(tree.branches)
        ? tree.branches.filter((b) => b.isRunner).sort((a, b) => (a.nodeIndex ?? 0) - (b.nodeIndex ?? 0))
        : [];
      const runnerCount = runnerAnchors?.length ?? runnerBranches.length;
      const baseId = CONFIG.tree.branches.length;
      const runnerPoints = [];
      if (runnerCount > 0) {
        const runnerWorldY = bandTop + bandHeight * 0.52;
        const runnerSpan = width * baseSpan;
        const step = width * 0.055;
        const start = width * 0.05;
        for (let i = 0; i < runnerCount; i += 1) {
          const anchorX = runnerAnchors?.[i]?.x;
          const offset = Number.isFinite(anchorX) ? anchorX * runnerSpan : start + i * step;
          runnerPoints.push({
            branchId: runnerBranches[i]?.id ?? baseId + i,
            isRunner: true,
            nodeIndex: i,
            x: trunkX + side * offset,
            y: runnerWorldY - vY,
            span: width * 0.04,
          });
        }
      }

      // 年轮控件：EQ 三环同心（内 low/中 mid/外 high）+ FX 单环 + Volume 单环，
      // 一行排在带下部树干附近。半径随窄屏收缩（390px 可操作）。
      const ringRadius = Math.max(13, Math.min(width * 0.052, bandHeight * 0.045));
      const ringWorldY = bandTop + bandHeight * 0.87;
      const ringY = ringWorldY - vY;
      const ringGap = ringRadius * 3.1;
      const eqX = trunkX - ringGap;
      const fxX = trunkX;
      const volumeX = trunkX + ringGap;
      const rings = [
        { controlId: 'eqLowDb', group: 'eq', x: eqX, y: ringY, rInner: 0, rOuter: ringRadius * 0.48, label: RING_LABELS.eqLowDb },
        { controlId: 'eqMidDb', group: 'eq', x: eqX, y: ringY, rInner: ringRadius * 0.48, rOuter: ringRadius * 0.76, label: RING_LABELS.eqMidDb },
        { controlId: 'eqHighDb', group: 'eq', x: eqX, y: ringY, rInner: ringRadius * 0.76, rOuter: ringRadius * 1.05, label: RING_LABELS.eqHighDb },
        { controlId: 'reverbSend', group: 'fx', x: fxX, y: ringY, rInner: 0, rOuter: ringRadius * 1.05, label: RING_LABELS.reverbSend },
        { controlId: 'gain', group: 'volume', x: volumeX, y: ringY, rInner: 0, rOuter: ringRadius * 1.05, label: RING_LABELS.gain },
      ];
      const groupLabels = [
        { text: 'EQ', x: eqX, y: ringY + ringRadius * 1.05 },
        { text: 'FX', x: fxX, y: ringY + ringRadius * 1.05 },
        { text: 'VOL', x: volumeX, y: ringY + ringRadius * 1.05 },
      ];

      const spriteSize = bandHeight * 0.8;
      return {
        id: tree.id,
        species,
        mirror: !!tree.mirror,
        side,
        index,
        bandTop,
        bandHeight,
        worldY,
        screenY: worldY - vY,
        visible: bandTop + bandHeight - vY > -40 && bandTop - vY < height + 40,
        // 兼容旧布局字段：cell = 全宽声部带（affordance/label/命中沿用）。
        cellX: 0,
        cellY,
        cellWidth: width,
        cellHeight: bandHeight,
        trunkX,
        rootX: trunkX,
        rootY: bandTop + bandHeight * 0.92 - vY,
        spriteX: trunkX - spriteSize / 2,
        spriteY: cellY + bandHeight * 0.08,
        spriteSize,
        localScale: spriteSize / (CONFIG.tree.trunkHeight || 0.62),
        branchPoints,
        runnerPoints,
        branchYs: branchPoints.map((point) => point.y),
        rings,
        groupLabels,
        focused: focusTreeId != null && tree.id === focusTreeId,
      };
    });
}
