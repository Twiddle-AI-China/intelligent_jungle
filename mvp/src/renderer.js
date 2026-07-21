// mvp/src/renderer.js —— 单树纵向 duotone-riso 渲染器（docs/single-tree-ui-design-2026-07-21.md）。
// 视觉一棵连续树、逻辑四 treeId：世界坐标 + viewportY 投影（scene-layout.js）；
// 相机移动只浏览，不触碰 world.setTreeControl / audio.setZoomFocus。
// 生产贴图：树干拼接 / 声部枝群 / 姿态鸟 / 年轮底（config.visual.singleTree）；缺失时回退路径与旧 sheet。

import { CONFIG } from './config.js';
import {
  RING_RANGES, RING_LABELS,
  computeSceneLayout, computeWorldMetrics,
  clampViewportY, focusViewportY, visibleVoiceAt,
} from './scene-layout.js';

const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
const smoothstep = (value) => { const x = clamp(value); return x * x * (3 - 2 * x); };

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
const css = ([r, g, b], alpha = 1) => `rgba(${r},${g},${b},${alpha})`;
const mix = (a, b, amount) => a.map((value, index) => Math.round(value + (b[index] - value) * amount));

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0; value = (value + 0x6D2B79F5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_BRANCH_ANCHORS = [
  { x: 0.68, y: 0.72, span: 0.34 }, { x: 0.32, y: 0.60, span: 0.34 },
  { x: 0.68, y: 0.48, span: 0.34 }, { x: 0.32, y: 0.36, span: 0.32 },
  { x: 0.68, y: 0.24, span: 0.30 },
];
const BIRD_HEIGHT = { pad: 0.145, melody: 0.135, bass: 0.175, texture: 0.145 };

// ---- 旧 2×2 四象限布局（保留导出兼容 renderer-layout.test.js；运行时渲染已改用单树 scene-layout）----
// 纯函数：树贴图占据 2×2 四象限；枝点由 config 的图片归一化锚点换算到 canvas。
export function computeTreeLayout(trees, width, height, { focusTreeId = null } = {}) {
  const outer = Math.max(18, Math.min(width, height) * 0.035);
  const gapX = Math.max(18, width * 0.035);
  const gapY = Math.max(22, height * 0.055);

  function layoutCell(tree, index, cellX, cellY, cellWidth, cellHeight) {
    const visualTop = cellY + cellHeight * 0.10;
    const visualHeight = cellHeight * 0.86;
    const spriteSize = Math.min(cellWidth * 0.94, visualHeight) * (tree.drawScale ?? 1);
    const spriteX = cellX + (cellWidth - spriteSize) / 2;
    const spriteY = visualTop + (visualHeight - spriteSize) / 2;
    const anchors = tree.branchAnchors?.length === 5 ? tree.branchAnchors : DEFAULT_BRANCH_ANCHORS;
    const branchPoints = anchors.map((anchor, branchId) => ({
      branchId,
      isRunner: false,
      x: spriteX + (tree.mirror ? 1 - anchor.x : anchor.x) * spriteSize,
      y: spriteY + anchor.y * spriteSize,
      span: anchor.span * spriteSize,
    }));
    // C6：横向 runner 节点（西→东）；优先用 tree.runnerAnchors，否则从 snapshot branches 推。
    const runnerAnchors = Array.isArray(tree.runnerAnchors) ? tree.runnerAnchors : null;
    const runnerBranches = Array.isArray(tree.branches)
      ? tree.branches.filter((b) => b.isRunner).sort((a, b) => (a.nodeIndex ?? 0) - (b.nodeIndex ?? 0))
      : [];
    const runnerPoints = [];
    if (runnerAnchors?.length) {
      const baseId = CONFIG.tree.branches.length;
      for (let i = 0; i < runnerAnchors.length; i += 1) {
        const anchor = runnerAnchors[i];
        runnerPoints.push({
          branchId: runnerBranches[i]?.id ?? baseId + i,
          isRunner: true,
          nodeIndex: i,
          x: spriteX + (tree.mirror ? 1 - anchor.x : anchor.x) * spriteSize,
          y: spriteY + anchor.y * spriteSize,
          span: spriteSize * 0.08,
        });
      }
    } else if (runnerBranches.length) {
      for (const branch of runnerBranches) {
        // snapshot 坐标是世界归一化；换算到本格贴图空间
        const localX = (branch.base?.x ?? 0) - (tree.xOffset ?? 0);
        const localY = branch.base?.y ?? CONFIG.tree.trunkHeight * 0.4;
        runnerPoints.push({
          branchId: branch.id,
          isRunner: true,
          nodeIndex: branch.nodeIndex ?? 0,
          x: spriteX + spriteSize * 0.5 + localX * (spriteSize / (CONFIG.tree.trunkHeight || 0.62)),
          y: spriteY + spriteSize * 0.90 - localY * (spriteSize / (CONFIG.tree.trunkHeight || 0.62)),
          span: spriteSize * 0.08,
        });
      }
    }
    const row = clamp(Math.trunc(tree.layout?.row ?? Math.floor(index / 2)), 0, 1);
    const col = clamp(Math.trunc(tree.layout?.col ?? index % 2), 0, 1);
    return {
      id: tree.id,
      species: tree.species ?? tree.id,
      mirror: !!tree.mirror,
      row, col, cellX, cellY, cellWidth, cellHeight,
      spriteX, spriteY, spriteSize,
      rootX: spriteX + spriteSize * 0.5,
      rootY: spriteY + spriteSize * 0.90,
      treeHeight: spriteSize,
      localScale: spriteSize / (CONFIG.tree.trunkHeight || 0.62),
      branchPoints,
      runnerPoints,
      branchYs: branchPoints.map((point) => point.y),
      focused: focusTreeId != null && tree.id === focusTreeId,
    };
  }

  if (focusTreeId && trees.some((tree) => tree.id === focusTreeId)) {
    const strip = Math.max(64, Math.min(width, height) * 0.16);
    const focus = trees.find((tree) => tree.id === focusTreeId);
    const others = trees.filter((tree) => tree.id !== focusTreeId);
    const main = layoutCell(
      focus,
      trees.indexOf(focus),
      outer,
      outer,
      Math.max(1, width - outer * 2 - strip - gapX),
      Math.max(1, height - outer * 2),
    );
    const stripX = width - outer - strip;
    const slotH = Math.max(1, (height - outer * 2 - gapY * Math.max(0, others.length - 1)) / Math.max(1, others.length));
    const side = others.map((tree, index) => layoutCell(
      tree,
      trees.indexOf(tree),
      stripX,
      outer + index * (slotH + gapY),
      strip,
      slotH,
    ));
    return [main, ...side];
  }

  const cellWidth = Math.max(1, (width - outer * 2 - gapX) / 2);
  const cellHeight = Math.max(1, (height - outer * 2 - gapY) / 2);
  return trees.map((tree, index) => {
    const row = clamp(Math.trunc(tree.layout?.row ?? Math.floor(index / 2)), 0, 1);
    const col = clamp(Math.trunc(tree.layout?.col ?? index % 2), 0, 1);
    return layoutCell(
      tree,
      index,
      outer + col * (cellWidth + gapX),
      outer + row * (cellHeight + gapY),
      cellWidth,
      cellHeight,
    );
  });
}

function loadImage(src) {
  if (!src || typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      console.warn(`渲染贴图加载失败，使用兼容素材或文字兜底: ${src}`);
      resolve(null);
    };
    image.src = src;
  });
}

export function createRenderer(canvas, config = CONFIG) {
  const visual = config.visual;
  const singleTree = visual.singleTree ?? {};
  const context = canvas.getContext('2d');
  const paper = hexToRgb(visual.paper);
  const ink = hexToRgb(visual.ink);
  const accent = hexToRgb(visual.accent);
  const paperNight = hexToRgb(visual.paperNight);
  const inkNight = hexToRgb(visual.inkNight);
  const flashes = new Map();
  const lastPositions = new Map();
  const assets = new Map(config.trees.map((tree) => [tree.id, { tree: null, bird: null }]));
  const backgrounds = new Map(Object.keys(visual.backgroundAssets ?? {}).map((season) => [season, null]));
  const legacy = { tree: null, perched: null, flying: null };
  const sceneAssets = {
    trunkMain: null,
    trunkVariants: [],
    branches: new Map(),
    birdPoses: new Map(), // voice -> { perchedLeft, perchedRight, flyingUp, flyingDown }
    rings: { small: null, medium: null, large: null },
  };
  let lastSim = 0;
  let currentSeason = null;
  let previousSeason = null;
  let seasonTransitionAt = 0;
  let focusTreeId = null;
  let hoverTreeId = null;
  let lastLayouts = [];
  let lastLayoutById = {};
  let lastSnapshot = null;
  // 单树相机：世界坐标 viewportY（像素，随 canvas 高变化在使用处重新 clamp）。
  // 相机只浏览；移动它绝不同步 USER / audio focus。
  let viewportY = 0;
  // 年轮控件值（原始单位：eq dB / reverbSend 0..1 / gain 0..2），默认值取自 config 音色表。
  const ringValues = new Map(config.trees.map((tree) => {
    const timbre = config.audio?.timbres?.[tree.species] ?? {};
    return [tree.id, {
      eqLowDb: Number(timbre.eqLowDb) || 0,
      eqMidDb: Number(timbre.eqMidDb) || 0,
      eqHighDb: Number(timbre.eqHighDb) || 0,
      reverbSend: Number.isFinite(Number(timbre.reverbSend)) ? Number(timbre.reverbSend) : 0,
      gain: Number.isFinite(Number(timbre.gain)) ? Number(timbre.gain) : 1,
    }];
  }));

  for (const tree of config.trees) {
    loadImage(tree.treeAsset).then((image) => { assets.get(tree.id).tree = image; });
    loadImage(tree.birdAsset).then((image) => { assets.get(tree.id).bird = image; });
  }
  loadImage(visual.treeImage).then((image) => { legacy.tree = image; });
  loadImage(visual.birdPerchedImage).then((image) => { legacy.perched = image; });
  loadImage(visual.birdFlyImage).then((image) => { legacy.flying = image; });
  for (const [season, src] of Object.entries(visual.backgroundAssets ?? {})) {
    loadImage(src).then((image) => { backgrounds.set(season, image); });
  }
  // 单树生产贴图（树干 / 枝群 / 姿态鸟 / 年轮底）
  loadImage(singleTree.trunkMain).then((image) => { sceneAssets.trunkMain = image; });
  for (const src of singleTree.trunkVariants ?? []) {
    loadImage(src).then((image) => {
      if (image) sceneAssets.trunkVariants.push(image);
    });
  }
  for (const [voice, src] of Object.entries(singleTree.branchAssets ?? {})) {
    loadImage(src).then((image) => { sceneAssets.branches.set(voice, image); });
  }
  for (const [voice, poses] of Object.entries(singleTree.birdPoses ?? {})) {
    const bag = {};
    sceneAssets.birdPoses.set(voice, bag);
    for (const [pose, src] of Object.entries(poses)) {
      loadImage(src).then((image) => { bag[pose] = image; });
    }
  }
  for (const [size, src] of Object.entries(singleTree.ringAssets ?? {})) {
    loadImage(src).then((image) => { sceneAssets.rings[size] = image; });
  }

  function ellipse(x, y, rx, ry, color, alpha = 1) {
    context.fillStyle = css(color, alpha);
    context.beginPath();
    context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    context.fill();
  }

  function grain(color, alpha) {
    const rng = mulberry32(97);
    context.save();
    context.fillStyle = css(color, alpha);
    const count = Math.floor(canvas.width * canvas.height / 2600);
    for (let index = 0; index < count; index += 1) {
      context.beginPath();
      context.arc(rng() * canvas.width, rng() * canvas.height, 0.35 + rng() * 1.15, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  function drawCoverImage(image, alpha) {
    if (!image || alpha <= 0) return false;
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.save();
    context.globalAlpha = alpha;
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    context.restore();
    return true;
  }

  function drawSeasonBackground(season, simTime, fallbackColor, dayFactor) {
    if (currentSeason === null) currentSeason = season;
    else if (season !== currentSeason) {
      previousSeason = currentSeason;
      currentSeason = season;
      seasonTransitionAt = simTime;
    }

    context.fillStyle = css(fallbackColor);
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fadeSeconds = Math.max(0.01, visual.seasonFadeSeconds ?? 1.5);
    const progress = clamp((simTime - seasonTransitionAt) / fadeSeconds);
    const baseAlpha = visual.backgroundOpacity ?? 0.76;
    const previous = previousSeason ? backgrounds.get(previousSeason) : null;
    const current = backgrounds.get(currentSeason);
    if (previous && progress < 1) drawCoverImage(previous, baseAlpha * (1 - progress));
    drawCoverImage(current, baseAlpha * (previous && progress < 1 ? progress : 1));
    if (progress >= 1) previousSeason = null;

    // 背景母版是日景；夜间只以同一靛蓝纸底压暗，不增加第四色相。
    const nightAlpha = (1 - dayFactor) * 0.82;
    if (nightAlpha > 0) {
      context.fillStyle = css(paperNight, nightAlpha);
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function drawTreeSprite(layout, image, dayFactor) {
    if (!image) return false;
    context.save();
    context.globalAlpha = 0.82 + dayFactor * 0.18;
    context.filter = dayFactor < 0.35 ? 'brightness(1.5) saturate(0.65)' : 'none';
    if (layout.mirror) {
      context.translate(layout.spriteX + layout.spriteSize, layout.spriteY);
      context.scale(-1, 1);
      context.drawImage(image, 0, 0, layout.spriteSize, layout.spriteSize);
    } else {
      context.drawImage(image, layout.spriteX, layout.spriteY, layout.spriteSize, layout.spriteSize);
    }
    context.restore();
    return true;
  }

  function drawPitchOverlay(layout, color, treeBirds, simTime) {
    for (const point of layout.branchPoints) {
      const perchedBirds = treeBirds.filter((bird) => bird.state === 'perched' && bird.branchId === point.branchId);
      const flashed = perchedBirds.some((bird) => simTime - (flashes.get(bird.id) ?? -Infinity) < visual.flashSeconds);
      const occupied = perchedBirds.length > 0;

      context.save();
      context.strokeStyle = css(color, occupied ? 0.22 : 0.10);
      context.lineWidth = Math.max(1, layout.cellHeight * 0.0025);
      context.setLineDash([layout.cellWidth * 0.012, layout.cellWidth * 0.018]);
      context.beginPath();
      context.moveTo(layout.cellX + layout.cellWidth * 0.08, point.y);
      context.lineTo(layout.cellX + layout.cellWidth * 0.92, point.y);
      context.stroke();
      context.setLineDash([]);

      if (flashed) {
        context.strokeStyle = css(accent, 0.22);
        context.lineWidth = Math.max(10, layout.cellHeight * 0.04);
        context.beginPath();
        context.moveTo(point.x - point.span * 0.48, point.y);
        context.lineTo(point.x + point.span * 0.48, point.y);
        context.stroke();
      }
      context.strokeStyle = css(flushedColor(color, accent, flashed), occupied || flashed ? 0.92 : 0.35);
      context.lineWidth = Math.max(2, layout.cellHeight * (occupied || flashed ? 0.012 : 0.006));
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(point.x - point.span * 0.44, point.y);
      context.lineTo(point.x + point.span * 0.44, point.y);
      context.stroke();

      const labelSide = point.x < layout.rootX ? -1 : 1;
      context.fillStyle = css(color, 0.58);
      context.font = `${Math.max(9, layout.cellHeight * 0.04)}px ui-monospace, monospace`;
      context.textAlign = labelSide < 0 ? 'right' : 'left';
      context.fillText(String(point.branchId + 1), point.x + labelSide * point.span * 0.52, point.y + 3);
      context.restore();
    }
    drawRunnerOverlay(layout, color, treeBirds, simTime);
  }

  // C6：横向 runner = 一条水平枝 + 节点圆点；栖鸟位置即当前音序位。
  function drawRunnerOverlay(layout, color, treeBirds, simTime) {
    const points = layout.runnerPoints ?? [];
    if (points.length < 1) return;
    context.save();
    const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    context.strokeStyle = css(color, 0.42);
    context.lineWidth = Math.max(1.5, layout.cellHeight * 0.006);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(points[0].x, y);
    context.lineTo(points[points.length - 1].x, y);
    context.stroke();
    // 轻连到树干，暗示「枝」而非漂浮 UI 条
    context.strokeStyle = css(color, 0.22);
    context.lineWidth = Math.max(1, layout.cellHeight * 0.0035);
    context.beginPath();
    context.moveTo(layout.rootX, layout.rootY - layout.spriteSize * 0.35);
    context.lineTo(layout.rootX, y);
    context.stroke();

    for (const point of points) {
      const perchedBirds = treeBirds.filter((bird) => bird.state === 'perched' && bird.branchId === point.branchId);
      const flashed = perchedBirds.some((bird) => simTime - (flashes.get(bird.id) ?? -Infinity) < visual.flashSeconds);
      const occupied = perchedBirds.length > 0;
      const radius = Math.max(3.5, layout.cellHeight * (occupied || flashed ? 0.016 : 0.011));
      if (flashed) {
        context.fillStyle = css(accent, 0.20);
        context.beginPath();
        context.arc(point.x, point.y, radius * 2.2, 0, Math.PI * 2);
        context.fill();
      }
      context.fillStyle = css(flushedColor(color, accent, flashed || occupied), occupied || flashed ? 0.95 : 0.45);
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = css(color, occupied ? 0.55 : 0.28);
      context.lineWidth = 1;
      context.stroke();
    }
    context.restore();
  }

  function flushedColor(base, highlight, flashed) { return flashed ? highlight : base; }

  function perchPoint(layout, bird) {
    const runner = (layout.runnerPoints ?? []).find((point) => point.branchId === bird.branchId);
    if (runner) return { x: runner.x, y: runner.y };
    const branchId = clamp(Math.trunc(bird.branchId ?? 0), 0, Math.max(0, layout.branchPoints.length - 1));
    const point = layout.branchPoints[branchId];
    if (!point) return { x: layout.rootX, y: layout.rootY - layout.spriteSize * 0.4 };
    const slot = clamp(Math.trunc(bird.slotIndex ?? 0), 0, 2);
    return { x: point.x + (slot - 1) * point.span * 0.22, y: point.y };
  }

  function birdPoint(layout, tree, bird) {
    if (bird.state === 'perched') return perchPoint(layout, bird);
    return {
      x: layout.rootX + (bird.pos.x - tree.xOffset) * layout.localScale,
      y: layout.rootY - bird.pos.y * layout.localScale,
    };
  }

  function drawBirdSprite(treeConfig, layout, bird, point, simTime) {
    const state = bird.state === 'perched' ? 'perched' : 'flying';
    const previousX = lastPositions.get(bird.id) ?? point.x;
    lastPositions.set(bird.id, point.x);
    const desiredFacing = state === 'perched'
      ? Math.sign(layout.rootX - point.x) || -1
      : Math.sign(point.x - previousX) || 1;

    // 优先单树姿态贴图（独立 PNG）；缺失时回退到旧四树 sheet / legacy。
    const poses = sceneAssets.birdPoses.get(treeConfig.species) ?? sceneAssets.birdPoses.get(treeConfig.id);
    let image = null;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let sh = 0;
    let nativeFacing = desiredFacing;
    if (poses) {
      if (state === 'perched') {
        image = desiredFacing < 0 ? (poses.perchedLeft ?? poses.perchedRight) : (poses.perchedRight ?? poses.perchedLeft);
        nativeFacing = desiredFacing < 0 ? -1 : 1;
      } else {
        // 角色板 2×2：左下 = flying-up（朝左），右下 = flying-down（朝右）；按拍翅交替。
        const wingUp = Math.floor(simTime * 6 + (bird.id?.length ?? 0)) % 2 === 0;
        image = wingUp ? (poses.flyingUp ?? poses.flyingDown) : (poses.flyingDown ?? poses.flyingUp);
        nativeFacing = wingUp ? -1 : 1;
        if (!wingUp && !poses.flyingDown) nativeFacing = -1;
        if (wingUp && !poses.flyingUp) nativeFacing = 1;
      }
      if (image) {
        sw = image.width;
        sh = image.height;
      }
    }
    if (!image) {
      const primary = assets.get(treeConfig.id)?.bird;
      image = primary ?? legacy[state];
      if (!image) return;
      const frame = primary ? treeConfig.birdFrames?.[state] : null;
      sx = frame ? frame.x * image.width : 0;
      sy = frame ? frame.y * image.height : 0;
      sw = frame ? frame.w * image.width : image.width;
      sh = frame ? frame.h * image.height : image.height;
      nativeFacing = state === 'perched' ? -1 : 1;
    }

    const flashAge = simTime - (flashes.get(bird.id) ?? -Infinity);
    const flash = flashAge >= 0 && flashAge < visual.flashSeconds
      ? smoothstep(1 - flashAge / visual.flashSeconds) : 0;
    const height = layout.cellHeight * (BIRD_HEIGHT[treeConfig.species] ?? 0.145)
      * (1 + (visual.flashScale - 1) * flash);
    const width = height * (sw / sh);
    const flip = desiredFacing !== nativeFacing;
    const top = state === 'perched' ? point.y - height * 0.88 : point.y - height * 0.50;

    if (flash > 0) ellipse(point.x, point.y - height * 0.48, width * 0.60, height * 0.58, accent, flash * 0.18);
    context.save();
    context.globalAlpha = 0.92 + flash * 0.08;
    if (flip) {
      context.translate(point.x, 0);
      context.scale(-1, 1);
      context.drawImage(image, sx, sy, sw, sh, -width / 2, top, width, height);
    } else {
      context.drawImage(image, sx, sy, sw, sh, point.x - width / 2, top, width, height);
    }
    context.restore();
  }

  function drawTreeLabel(layout, color) {
    const labels = { pad: 'PAD · 斑鸠', melody: 'MELODY · 百灵', bass: 'BASS · 鹈鹕', texture: 'TEXTURE · 啄木鸟' };
    context.fillStyle = css(color, 0.66);
    context.font = `600 ${Math.max(10, layout.cellHeight * 0.045)}px ui-monospace, monospace`;
    context.textAlign = 'left';
    context.fillText(labels[layout.species] ?? layout.species.toUpperCase(), layout.cellX + layout.cellWidth * 0.05, layout.cellY + layout.cellHeight * 0.07);
  }

  // WS-2：可点树 affordance——hover 描边 + 角标「点选」；特写实线；不引入第四色相。
  // 单树验收「无四宫格」：不画常驻全 band 虚线框，只在 hover/focus 时提示。
  function drawTreeAffordance(layout, color) {
    const hovered = hoverTreeId === layout.id;
    const focused = layout.focused;
    if (!hovered && !focused) return;
    context.save();
    context.strokeStyle = css(focused ? accent : color, focused ? 0.95 : 0.72);
    context.lineWidth = Math.max(2, layout.cellHeight * (focused ? 0.008 : 0.006));
    context.setLineDash(focused ? [] : [8, 5]);
    context.strokeRect(
      layout.cellX + layout.cellWidth * 0.015,
      layout.cellY + layout.cellHeight * 0.015,
      layout.cellWidth * 0.97,
      layout.cellHeight * 0.97,
    );
    const tip = focused ? '特写 · USER' : '点选接管';
    const fontPx = Math.max(10, layout.cellHeight * 0.038);
    context.font = `700 ${fontPx}px ui-monospace, monospace`;
    context.textAlign = 'right';
    const tipX = layout.cellX + layout.cellWidth * 0.95;
    const tipY = layout.cellY + layout.cellHeight * 0.07;
    const measured = typeof context.measureText === 'function' ? context.measureText(tip) : null;
    const tipW = (measured?.width ?? tip.length * fontPx * 0.6) + 10;
    context.fillStyle = css(paper, 0.88);
    context.fillRect(tipX - tipW, tipY - fontPx * 0.85, tipW, fontPx * 1.35);
    context.fillStyle = css(focused ? accent : color, 0.95);
    context.fillText(tip, tipX - 4, tipY + fontPx * 0.15);
    context.restore();
  }

  function drawCelestial(snapshot, bodyColor, alpha) {
    if (alpha <= 0.02) return;
    const short = Math.min(canvas.width, canvas.height);
    const radius = short * (visual.celestialRadiusRatio ?? 0.085);
    const arcCx = canvas.width * 0.5;
    const arcCy = canvas.height * (visual.celestialArcHeightRatio ?? 0.22);
    const spanX = canvas.width * (visual.celestialArcSpanRatio ?? 0.42);
    const spanY = canvas.height * (visual.celestialArcDepthRatio ?? 0.20);
    // phase 0→1：左地平 → 过顶 → 右地平（半周），昼夜各走一趟弧
    const isDay = snapshot.phase < 0.5;
    const local = isDay ? snapshot.phase * 2 : (snapshot.phase - 0.5) * 2;
    const theta = Math.PI - local * Math.PI;
    const x = arcCx + Math.cos(theta) * spanX;
    const y = arcCy + (1 - Math.sin(theta)) * spanY;

    // 淡弧轨：让「一天绕一圈」可从图上直接读到（ink，三 token）
    const arcAlpha = visual.celestialArcAlpha ?? 0.38;
    if (arcAlpha > 0.02) {
      context.save();
      context.strokeStyle = css(ink, arcAlpha);
      context.lineWidth = Math.max(2, short * 0.0045);
      context.beginPath();
      for (let i = 0; i <= 48; i += 1) {
        const t = i / 48;
        const th = Math.PI - t * Math.PI;
        const ax = arcCx + Math.cos(th) * spanX;
        const ay = arcCy + (1 - Math.sin(th)) * spanY;
        if (i === 0) context.moveTo(ax, ay);
        else context.lineTo(ax, ay);
      }
      context.stroke();
      context.restore();
    }

    if (isDay) {
      // 太阳：暖色径向渐层外晕 + 短射线光芒 + 实心盘
      const rayCount = 12;
      const rayInner = radius * 1.05;
      const rayOuter = radius * 1.85;
      context.save();
      context.strokeStyle = css(bodyColor, alpha * 0.72);
      context.lineWidth = Math.max(1.5, short * 0.0035);
      context.lineCap = 'round';
      for (let i = 0; i < rayCount; i += 1) {
        const ang = (i / rayCount) * Math.PI * 2;
        context.beginPath();
        context.moveTo(x + Math.cos(ang) * rayInner, y + Math.sin(ang) * rayInner);
        context.lineTo(x + Math.cos(ang) * rayOuter, y + Math.sin(ang) * rayOuter);
        context.stroke();
      }
      context.restore();
      const glow = context.createRadialGradient(x, y, radius * 0.2, x, y, radius * 1.7);
      glow.addColorStop(0, css(bodyColor, alpha * 0.55));
      glow.addColorStop(0.45, css(bodyColor, alpha * 0.22));
      glow.addColorStop(1, css(bodyColor, 0));
      context.save();
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius * 1.7, 0, Math.PI * 2);
      context.fill();
      context.restore();
      ellipse(x, y, radius, radius, bodyColor, alpha);
    } else {
      // 月亮：两圆相减峨眉月牙（主圆 − 偏右遮挡圆）
      const offset = radius * 0.42;
      context.save();
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.arc(x + offset, y - offset * 0.15, radius * 0.92, 0, Math.PI * 2, true);
      context.fillStyle = css(bodyColor, alpha);
      context.fill('evenodd');
      // 淡外晕（月牙轮廓外一圈弱光，不用实心盘）
      context.strokeStyle = css(bodyColor, alpha * 0.28);
      context.lineWidth = Math.max(1.2, short * 0.003);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.arc(x + offset, y - offset * 0.15, radius * 0.92, 0, Math.PI * 2, true);
      context.stroke();
      context.restore();
    }
  }

  // 单树连续树干：优先拼接生产贴图；缺失时回退路径 taper（§3：无四树拼接）。
  function drawTrunkPath(color, height) {
    const { worldHeight } = computeWorldMetrics(height);
    const width = canvas.width;
    const trunkX = width * 0.5;
    const steps = 56;
    const centerAt = (worldY) => trunkX + Math.sin((worldY / worldHeight) * Math.PI * 2.2) * width * 0.012;
    const halfAt = (worldY) => {
      const t = clamp(worldY / worldHeight); // 0=树顶 1=树根
      return width * (0.006 + 0.022 * t * t);
    };
    const left = [];
    const right = [];
    for (let i = 0; i <= steps; i += 1) {
      const worldY = (i / steps) * worldHeight;
      const screenY = worldY - viewportY;
      const cx = centerAt(worldY);
      const half = halfAt(worldY);
      left.push([cx - half, screenY]);
      right.push([cx + half, screenY]);
    }
    context.save();
    context.fillStyle = css(color, 0.88);
    context.beginPath();
    context.moveTo(left[0][0], left[0][1]);
    for (const [x, y] of left) context.lineTo(x, y);
    for (let i = right.length - 1; i >= 0; i -= 1) context.lineTo(right[i][0], right[i][1]);
    context.closePath();
    context.fill();
    const rootWorldY = worldHeight;
    const rootScreenY = rootWorldY - viewportY;
    if (rootScreenY > -20 && rootScreenY < height + 40) {
      context.strokeStyle = css(color, 0.5);
      context.lineWidth = Math.max(1.5, width * 0.003);
      context.lineCap = 'round';
      const baseX = centerAt(rootWorldY);
      for (const dir of [-1, 1]) {
        context.beginPath();
        context.moveTo(baseX, rootScreenY - width * 0.01);
        context.lineTo(baseX + dir * width * 0.045, rootScreenY + width * 0.008);
        context.stroke();
      }
    }
    context.restore();
  }

  function drawTrunk(color, height) {
    const tiles = [sceneAssets.trunkMain, ...sceneAssets.trunkVariants].filter(Boolean);
    if (!tiles.length) {
      drawTrunkPath(color, height);
      return;
    }
    const { worldHeight } = computeWorldMetrics(height);
    const drawW = canvas.width * (singleTree.trunkDrawWidthRatio ?? 0.22);
    const overlap = 0.08; // 段间重叠，隐藏接缝
    let worldY = 0;
    let index = 0;
    context.save();
    context.globalAlpha = 0.94;
    while (worldY < worldHeight) {
      const image = tiles[index % tiles.length];
      const drawH = drawW * (image.height / image.width);
      const screenY = worldY - viewportY;
      if (screenY + drawH > -20 && screenY < height + 20) {
        context.drawImage(image, canvas.width * 0.5 - drawW / 2, screenY, drawW, drawH);
      }
      worldY += drawH * (1 - overlap);
      index += 1;
      if (index > 64) break; // 安全阀
    }
    context.restore();
  }

  // 声部枝群贴图：靠树干一侧出画重叠，另一侧保留枝尖。
  function drawBranchCluster(layout) {
    const image = sceneAssets.branches.get(layout.species) ?? sceneAssets.branches.get(layout.id);
    if (!image || !layout.visible) return false;
    const height = layout.bandHeight * (singleTree.branchHeightRatio ?? 0.72);
    const width = height * (image.width / image.height);
    const top = layout.cellY + (layout.bandHeight - height) * 0.18;
    // side > 0：右生（左缘贴树干）；side < 0：左生（右缘贴树干）
    const left = layout.side > 0
      ? layout.trunkX - width * 0.06
      : layout.trunkX - width + width * 0.06;
    context.save();
    context.globalAlpha = 0.92;
    context.drawImage(image, left, top, width, height);
    context.restore();
    return true;
  }

  // 年轮控件（§4）：底纹贴图 + 靛蓝线稿环 + 橙红弧表示值；EQ 三环同心。
  function drawRings(layout, color) {
    const values = ringValues.get(layout.id);
    if (!values || !layout.rings?.length) return;
    context.save();
    // 三组底纹：EQ 用 large，FX/Volume 用 medium（缺失则跳过）。
    const groups = new Map();
    for (const ring of layout.rings) {
      if (!groups.has(ring.group)) groups.set(ring.group, ring);
    }
    for (const [group, ring] of groups) {
      const asset = group === 'eq'
        ? (sceneAssets.rings.large ?? sceneAssets.rings.medium)
        : (sceneAssets.rings.medium ?? sceneAssets.rings.small);
      if (!asset) continue;
      const size = ring.rOuter * 2.35;
      context.globalAlpha = 0.88;
      context.drawImage(asset, ring.x - size / 2, ring.y - size / 2, size, size);
      context.globalAlpha = 1;
    }
    for (const ring of layout.rings) {
      const range = RING_RANGES[ring.controlId];
      const norm = clamp((values[ring.controlId] - range[0]) / (range[1] - range[0]));
      const midR = (ring.rInner + ring.rOuter) / 2;
      const lineWidth = Math.max(1.5, (ring.rOuter - ring.rInner) * 0.62);
      context.strokeStyle = css(color, 0.5);
      context.lineWidth = lineWidth;
      context.beginPath();
      context.arc(ring.x, ring.y, midR, 0, Math.PI * 2);
      context.stroke();
      if (norm > 0.003) {
        context.strokeStyle = css(accent, 0.92);
        context.beginPath();
        context.arc(ring.x, ring.y, midR, -Math.PI / 2, -Math.PI / 2 + norm * Math.PI * 2);
        context.stroke();
      }
    }
    const fontPx = Math.max(9, layout.cellHeight * 0.018);
    context.fillStyle = css(color, 0.6);
    context.font = `600 ${fontPx}px ui-monospace, monospace`;
    context.textAlign = 'center';
    for (const label of layout.groupLabels ?? []) {
      context.fillText(label.text, label.x, label.y + fontPx * 1.1);
    }
    context.restore();
  }

  function resize() { /* 贴图目标矩形与锚点每帧按 canvas 尺寸重算 */ }
  function flash(birdId) { flashes.set(birdId, lastSim); }
  function setFocusTree(treeId) {
    focusTreeId = treeId && config.trees.some((tree) => tree.id === treeId) ? treeId : null;
    // 显式接管（USER）时把相机吸附到该声部带；这只是浏览位置，不触碰 world/audio。
    if (focusTreeId) viewportY = focusViewportY(focusTreeId, canvas.height);
    return focusTreeId;
  }
  function getFocusTree() { return focusTreeId; }
  function toggleFocusTree(treeId) {
    return setFocusTree(focusTreeId === treeId ? null : treeId);
  }
  function setHoverTree(treeId) {
    hoverTreeId = treeId && config.trees.some((tree) => tree.id === treeId) ? treeId : null;
    return hoverTreeId;
  }
  function getHoverTree() { return hoverTreeId; }

  // ---- 单树相机接口（§6 Worker A）：只移动视口，不切 USER、不改 audio focus ----
  function setViewportY(value) {
    viewportY = clampViewportY(value, canvas.height);
    return viewportY;
  }
  function getViewportY() { return clampViewportY(viewportY, canvas.height); }
  // delta 以声部带高为单位（1 = 下移一个声部；小数做连续滚动；世界 Y 向下增大）。
  function moveViewportBy(delta) {
    const { bandHeight } = computeWorldMetrics(canvas.height);
    return setViewportY(getViewportY() + (Number(delta) || 0) * bandHeight);
  }
  // 吸附浏览到指定声部（≠ setFocusTree：不改变 USER/焦点语义）。
  function focusVoice(treeId) {
    if (!config.trees.some((tree) => tree.id === treeId)) return null;
    viewportY = focusViewportY(treeId, canvas.height);
    return treeId;
  }
  function getVisibleVoice() { return visibleVoiceAt(getViewportY(), canvas.height); }

  // ---- 年轮控件（§4）：值读写与可访问描述（Worker B 据此接 DOM/键盘入口）----
  function setRingValue(treeId, controlId, value) {
    const values = ringValues.get(treeId);
    const range = RING_RANGES[controlId];
    if (!values || !range) return null;
    const next = clamp(Number(value) || 0, range[0], range[1]);
    values[controlId] = next;
    return next;
  }
  function getRingValue(treeId, controlId) {
    return ringValues.get(treeId)?.[controlId] ?? null;
  }
  // 当前帧的屏幕坐标 + 名称/数值/范围/步进，供 DOM 可访问控件与键盘调整使用。
  function getRingControls() {
    const controls = [];
    for (const layout of lastLayouts) {
      for (const ring of layout.rings ?? []) {
        const range = RING_RANGES[ring.controlId];
        controls.push({
          treeId: layout.id,
          controlId: ring.controlId,
          label: ring.label ?? RING_LABELS[ring.controlId] ?? ring.controlId,
          value: ringValues.get(layout.id)?.[ring.controlId] ?? range[0],
          min: range[0],
          max: range[1],
          step: (range[1] - range[0]) / 40,
          x: ring.x,
          y: ring.y,
          rInner: ring.rInner,
          rOuter: ring.rOuter,
        });
      }
    }
    return controls;
  }

  // 画布命中：鸟 > 年轮 > 枝 > 树身（声部带）；坐标为 canvas CSS 像素。
  // 契约保留：bird/branch/tree 仍返回 { type, treeId, branchId, birdId }；ring 为新增类型。
  // 不可见（画布外）声部带全程不命中，与绘制裁剪一致（§3）。
  function hitTest(canvasX, canvasY, snapshot = lastSnapshot) {
    if (!snapshot || !lastLayouts.length) return null;
    const treeById = Object.fromEntries(snapshot.trees.map((tree) => [tree.id, tree]));
    const configById = Object.fromEntries(config.trees.map((tree) => [tree.id, tree]));
    // 鸟优先（特写里密枝点选）
    for (const bird of snapshot.birds) {
      if (bird.state !== 'perched') continue;
      const layout = lastLayoutById[bird.treeId];
      const tree = treeById[bird.treeId];
      const treeConfig = configById[bird.treeId];
      if (!layout || !layout.visible || !tree || !treeConfig) continue;
      const point = birdPoint(layout, tree, bird);
      const height = layout.cellHeight * (BIRD_HEIGHT[treeConfig.species] ?? 0.145);
      const width = height * 0.7;
      if (Math.abs(canvasX - point.x) <= width * 0.55 && canvasY <= point.y + height * 0.15
        && canvasY >= point.y - height) {
        return { type: 'bird', treeId: bird.treeId, birdId: bird.id, branchId: bird.branchId };
      }
    }
    // 年轮控件：环形命中带（含少量容差），先于枝与树身。
    // EQ 同心环在 ±3px 容差内会重叠：按最近中径 |dist - midR| 归属，内/中/外 = low/mid/high。
    let ringHit = null;
    for (const layout of lastLayouts) {
      if (!layout.visible) continue;
      for (const ring of layout.rings ?? []) {
        const dist = Math.hypot(canvasX - ring.x, canvasY - ring.y);
        if (dist < ring.rInner - 3 || dist > ring.rOuter + 3) continue;
        const off = Math.abs(dist - (ring.rInner + ring.rOuter) / 2);
        if (!ringHit || off < ringHit.off) {
          ringHit = { type: 'ring', treeId: layout.id, ringId: ring.controlId, off };
        }
      }
    }
    if (ringHit) return { type: 'ring', treeId: ringHit.treeId, ringId: ringHit.ringId };
    // 枝命中可能重叠（hitR 大于枝距）：取最近点而非首个，保证密枝区可点选目标枝。
    let branchHit = null;
    for (const layout of lastLayouts) {
      if (!layout.visible) continue;
      for (const point of [...layout.branchPoints, ...(layout.runnerPoints ?? [])]) {
        const hitR = Math.max(14, point.span * 0.55, layout.cellHeight * 0.035);
        const dist = Math.hypot(canvasX - point.x, canvasY - point.y);
        if (dist <= hitR && (!branchHit || dist < branchHit.dist)) {
          branchHit = { type: 'branch', treeId: layout.id, branchId: point.branchId, dist };
        }
      }
    }
    if (branchHit) return { type: 'branch', treeId: branchHit.treeId, branchId: branchHit.branchId };
    // 树身：声部带内点击即该声部（旧 cell 语义，带 = 全宽纵向区段）。
    for (const layout of lastLayouts) {
      if (!layout.visible) continue;
      if (canvasX >= layout.cellX && canvasX <= layout.cellX + layout.cellWidth
        && canvasY >= layout.cellY && canvasY <= layout.cellY + layout.cellHeight) {
        return { type: 'tree', treeId: layout.id };
      }
    }
    return null;
  }

  function render(snapshot) {
    lastSim = snapshot.simTime;
    lastSnapshot = snapshot;
    const dayFactor = smoothstep((snapshot.daylight - visual.nightEdge) / visual.transitionSpan);
    const background = mix(paperNight, paper, dayFactor);
    const currentInk = mix(inkNight, ink, dayFactor);
    const season = snapshot.season ?? snapshot.harmonicFrame?.season ?? 'spring';
    drawSeasonBackground(season, snapshot.simTime, background, dayFactor);
    grain(currentInk, visual.paperGrainAlpha);
    drawCelestial(
      snapshot,
      snapshot.phase < 0.5 ? accent : inkNight,
      snapshot.phase < 0.5 ? Math.max(0.55, dayFactor) * visual.sunAlpha
        : Math.max(0.55, 1 - dayFactor) * visual.moonAlpha,
    );

    const configById = Object.fromEntries(config.trees.map((tree) => [tree.id, tree]));
    const layoutInput = snapshot.trees.map((tree) => ({ ...tree, ...(configById[tree.id] ?? {}) }));
    viewportY = clampViewportY(viewportY, canvas.height);
    const layouts = computeSceneLayout(layoutInput, canvas.width, canvas.height, { viewportY, focusTreeId });
    lastLayouts = layouts;
    lastLayoutById = Object.fromEntries(layouts.map((layout) => [layout.id, layout]));
    const treeById = Object.fromEntries(snapshot.trees.map((tree) => [tree.id, tree]));

    // 一棵连续树干贯穿全树；声部带、枝群、年轮投影到当前视口。
    drawTrunk(currentInk, canvas.height);
    for (const layout of layouts) {
      if (!layout.visible) continue; // 画布外声部不绘制；world/audio 状态不动
      const tree = treeById[layout.id];
      drawTreeAffordance(layout, currentInk);
      drawTreeLabel(layout, currentInk);
      const drewBranches = drawBranchCluster(layout);
      // 有枝群贴图时只保留轻量音高/runner 提示；无贴图时 pitch overlay 仍是主表达。
      if (!drewBranches) {
        drawPitchOverlay(layout, currentInk, tree.birds, snapshot.simTime);
      } else {
        drawRunnerOverlay(layout, currentInk, tree.birds, snapshot.simTime);
        // 轻量枝编号，方便点选
        context.save();
        context.fillStyle = css(currentInk, 0.45);
        context.font = `${Math.max(9, layout.cellHeight * 0.035)}px ui-monospace, monospace`;
        for (const point of layout.branchPoints) {
          const labelSide = layout.side;
          context.textAlign = labelSide < 0 ? 'right' : 'left';
          context.fillText(
            String(point.branchId + 1),
            point.x + labelSide * point.span * 0.52,
            point.y + 3,
          );
        }
        context.restore();
      }
      drawRings(layout, currentInk);
    }
    for (const bird of snapshot.birds) {
      const tree = treeById[bird.treeId];
      const layout = lastLayoutById[bird.treeId];
      const treeConfig = configById[bird.treeId];
      if (!tree || !layout || !treeConfig || !layout.visible) continue;
      drawBirdSprite(treeConfig, layout, bird, birdPoint(layout, tree, bird), snapshot.simTime);
    }
  }

  return {
    render, flash, resize, hitTest,
    setFocusTree, getFocusTree, toggleFocusTree,
    setHoverTree, getHoverTree,
    setViewportY, getViewportY, moveViewportBy, focusVoice, getVisibleVoice,
    setRingValue, getRingValue, getRingControls,
  };
}
