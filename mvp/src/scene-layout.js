// mvp/src/scene-layout.js —— 单树纵向世界坐标与相机（纯函数，无 DOM/Canvas 依赖）。
// 规格：docs/single-tree-ui-design-2026-07-21.md §3/§4/§6 Worker A。
// 视觉一棵树、逻辑四 treeId：四个声部带纵向堆叠（上→下 pad/melody/bass/texture），
// 枝群单侧且左右交替；所有位置先算世界坐标，再以 screenY = worldY - viewportY 投影。

import { VIEW_CONFIG } from './view-config.js';
import { defaultViewSequenceDimensions } from './view-sequence.js';

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

// Sequence v2 的横轴投影：枝根→枝梢。当前只提供只读坐标，不改变旧 branch 命中。
// y 轴以生产贴图栖点为中心做极轻的交替弯曲，避免在手绘枝上盖一条机械直线。
export function sequenceLanePoints({
  treeId,
  pitchBranchId,
  side,
  branchRect,
  branchRootX,
  anchorY,
  stepCount = defaultViewSequenceDimensions().stepCount,
}) {
  const count = Math.max(1, Math.trunc(Number(stepCount)) || 1);
  const direction = side < 0 ? -1 : 1;
  const rootInset = branchRect.width * 0.07;
  const tipInset = branchRect.width * 0.10;
  const startX = branchRootX + direction * rootInset;
  const endX = direction > 0
    ? branchRect.x + branchRect.width - tipInset
    : branchRect.x + tipInset;
  const bend = (pitchBranchId % 2 === 0 ? -1 : 1) * branchRect.height * 0.012;
  return Array.from({ length: count }, (_, stepIndex) => {
    const t = count === 1 ? 0 : stepIndex / (count - 1);
    return {
      treeId,
      pitchBranchId,
      stepIndex,
      x: startX + (endX - startX) * t,
      y: anchorY + Math.sin(Math.PI * t) * bend,
    };
  });
}

// ---- 世界度量：四声部恰好两屏，一屏同时看见两个声部 ----
export function computeWorldMetrics(height) {
  const bandHeight = Math.max(height * 0.5, 240);
  const margin = 0;
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
  const clamped = clampViewportY(viewportY, height);
  const { worldHeight } = computeWorldMetrics(height);
  const maxViewport = Math.max(0, worldHeight - height);
  // 两屏布局的首尾视口各同时容纳两个声部；边界明确归最顶/最底声部，
  // 使定位器四个目标仍然互斥可达。
  if (clamped <= 1e-9) return VOICE_ORDER[0];
  if (clamped >= maxViewport - 1e-9) return VOICE_ORDER.at(-1);
  const center = clamped + height / 2;
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
      const singleTree = VIEW_CONFIG.visual?.singleTree ?? {};
      const branchAspect = singleTree.branchAspectRatio ?? (4 / 3);
      const naturalBranchHeight = bandHeight * (singleTree.branchHeightRatio ?? 0.9);
      const branchWidth = Math.min(naturalBranchHeight * branchAspect, width * 0.49);
      const branchHeight = branchWidth / branchAspect;
      const branchTop = cellY + (bandHeight - branchHeight) * 0.5;
      const rootInset = branchWidth * 0.025;
      const trunkDrawWidth = width * (singleTree.trunkDrawWidthRatio ?? 0.22);
      const joinOffset = trunkDrawWidth * (singleTree.branchJoinOffsetRatio ?? 0.22);
      const branchJoinX = trunkX + side * joinOffset;
      const branchLeft = side > 0
        ? branchJoinX - rootInset
        : branchJoinX - branchWidth + rootInset;
      const branchRect = { x: branchLeft, y: branchTop, width: branchWidth, height: branchHeight };
      const configuredAnchors = singleTree.branchNoteAnchors?.[species]
        ?? singleTree.branchNoteAnchors?.[tree.id];

      // 五层单侧枝：branchId 0=最低枝（低音）→4=最高枝。
      // 生产贴图、命中、鸟落点共用同一归一化锚点；缺配置时才使用程序兜底。
      const branchPoints = [];
      for (let branchId = 0; branchId < 5; branchId += 1) {
        const jitter = species === 'texture' ? (rng() - 0.5) * 0.05 : 0;
        const relY = 0.70 - branchId * 0.125 + jitter;
        const spanScale = species === 'texture' ? 0.72 + rng() * 0.55 : 0.92 + rng() * 0.16;
        const span = width * baseSpan * spanScale;
        const anchor = configuredAnchors?.[branchId];
        const x = Number.isFinite(anchor?.x)
          ? branchLeft + anchor.x * branchWidth
          : trunkX + side * span * 0.5;
        const y = Number.isFinite(anchor?.y)
          ? branchTop + anchor.y * branchHeight
          : bandTop + relY * bandHeight - vY;
        branchPoints.push({
          branchId,
          x,
          y,
          span,
        });
      }
      const sequenceStepCount = defaultViewSequenceDimensions({
        barsPerDay: VIEW_CONFIG.tempo.barsPerDay,
        beatsPerBar: VIEW_CONFIG.tempo.beatsPerBar,
      }).stepCount;
      const sequenceLanes = branchPoints.map((point) => ({
        pitchBranchId: point.branchId,
        points: sequenceLanePoints({
          treeId: tree.id,
          pitchBranchId: point.branchId,
          side,
          branchRect,
          branchRootX: branchJoinX,
          anchorY: point.y,
          stepCount: sequenceStepCount,
        }),
      }));

      // 年轮控件：三组沿树干竖排；EQ 仍是 low/mid/high 三层同心。
      const ringRadius = Math.max(12, Math.min(width * 0.034, bandHeight * 0.047));
      const ringGap = ringRadius * 2.65;
      const ringCenterY = worldY - vY;
      const eqX = trunkX;
      const fxX = trunkX;
      const volumeX = trunkX;
      const eqY = ringCenterY - ringGap;
      const fxY = ringCenterY;
      const volumeY = ringCenterY + ringGap;
      const rings = [
        { controlId: 'eqLowDb', group: 'eq', x: eqX, y: eqY, rInner: 0, rOuter: ringRadius * 0.48, label: RING_LABELS.eqLowDb },
        { controlId: 'eqMidDb', group: 'eq', x: eqX, y: eqY, rInner: ringRadius * 0.48, rOuter: ringRadius * 0.76, label: RING_LABELS.eqMidDb },
        { controlId: 'eqHighDb', group: 'eq', x: eqX, y: eqY, rInner: ringRadius * 0.76, rOuter: ringRadius * 1.05, label: RING_LABELS.eqHighDb },
        { controlId: 'reverbSend', group: 'fx', x: fxX, y: fxY, rInner: 0, rOuter: ringRadius * 1.05, label: RING_LABELS.reverbSend },
        { controlId: 'gain', group: 'volume', x: volumeX, y: volumeY, rInner: 0, rOuter: ringRadius * 1.05, label: RING_LABELS.gain },
      ];
      const groupLabels = [
        { text: 'EQ', x: eqX + ringRadius * 1.35, y: eqY },
        { text: 'FX', x: fxX + ringRadius * 1.35, y: fxY },
        { text: 'VOL', x: volumeX + ringRadius * 1.35, y: volumeY },
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
        branchRect,
        branchRoot: { x: branchJoinX, y: worldY - vY },
        localScale: spriteSize / (VIEW_CONFIG.tree.trunkHeight || 0.62),
        branchPoints,
        sequenceLanes,
        branchYs: branchPoints.map((point) => point.y),
        rings,
        groupLabels,
        focused: focusTreeId != null && tree.id === focusTreeId,
      };
    });
}
