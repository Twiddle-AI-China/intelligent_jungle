// mvp/src/renderer.js —— GPT 贴图驱动的三色 duotone-riso 渲染器。
// 树与鸟只通过 drawImage 绘制；canvas path 仅负责背景颗粒、音高导线与发音辉光。

import { CONFIG } from './config.js';

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

// 纯函数：树贴图占据 2×2 四象限；枝点由 config 的图片归一化锚点换算到 canvas。
// focusTreeId 时该树放大占主舞台，其余三树缩到边缘条带（特写视口，非新模式）。
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
      x: spriteX + (tree.mirror ? 1 - anchor.x : anchor.x) * spriteSize,
      y: spriteY + anchor.y * spriteSize,
      span: anchor.span * spriteSize,
    }));
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
  let lastSim = 0;
  let currentSeason = null;
  let previousSeason = null;
  let seasonTransitionAt = 0;
  let focusTreeId = null;
  let lastLayouts = [];
  let lastLayoutById = {};
  let lastSnapshot = null;

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
  }

  function flushedColor(base, highlight, flashed) { return flashed ? highlight : base; }

  function perchPoint(layout, bird) {
    const branchId = clamp(Math.trunc(bird.branchId ?? 0), 0, 4);
    const point = layout.branchPoints[branchId];
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
    const primary = assets.get(treeConfig.id)?.bird;
    const image = primary ?? legacy[state];
    if (!image) return;
    const frame = primary ? treeConfig.birdFrames?.[state] : null;
    const sx = frame ? frame.x * image.width : 0;
    const sy = frame ? frame.y * image.height : 0;
    const sw = frame ? frame.w * image.width : image.width;
    const sh = frame ? frame.h * image.height : image.height;
    const flashAge = simTime - (flashes.get(bird.id) ?? -Infinity);
    const flash = flashAge >= 0 && flashAge < visual.flashSeconds
      ? smoothstep(1 - flashAge / visual.flashSeconds) : 0;
    const height = layout.cellHeight * (BIRD_HEIGHT[treeConfig.species] ?? 0.145)
      * (1 + (visual.flashScale - 1) * flash);
    const width = height * (sw / sh);
    const previousX = lastPositions.get(bird.id) ?? point.x;
    lastPositions.set(bird.id, point.x);
    const desiredFacing = state === 'perched'
      ? Math.sign(layout.rootX - point.x) || -1
      : Math.sign(point.x - previousX) || 1;
    const nativeFacing = state === 'perched' ? -1 : 1;
    const flip = desiredFacing !== nativeFacing;
    const top = state === 'perched' ? point.y - height * 0.88 : point.y - height * 0.50;

    if (flash > 0) ellipse(point.x, point.y - height * 0.48, width * 0.60, height * 0.58, accent, flash * 0.18);
    context.save();
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

  function drawCelestial(snapshot, color, alpha) {
    if (alpha <= 0.02) return;
    const radius = Math.min(canvas.width, canvas.height) * visual.celestialRadiusRatio * 0.62;
    const x = canvas.width * (0.50 + Math.cos(snapshot.phase * Math.PI * 2) * 0.30);
    const y = canvas.height * (0.12 + Math.sin(snapshot.phase * Math.PI) * 0.04);
    ellipse(x, y, radius, radius, color, alpha);
  }

  function resize() { /* 贴图目标矩形与锚点每帧按 canvas 尺寸重算 */ }
  function flash(birdId) { flashes.set(birdId, lastSim); }
  function setFocusTree(treeId) {
    focusTreeId = treeId && config.trees.some((tree) => tree.id === treeId) ? treeId : null;
    return focusTreeId;
  }
  function getFocusTree() { return focusTreeId; }
  function toggleFocusTree(treeId) {
    return setFocusTree(focusTreeId === treeId ? null : treeId);
  }

  // 画布命中：鸟 > 枝 > 树身；坐标为 canvas CSS 像素（与 canvas 宽高比一致时由 main 换算）。
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
      if (!layout || !tree || !treeConfig) continue;
      const point = birdPoint(layout, tree, bird);
      const height = layout.cellHeight * (BIRD_HEIGHT[treeConfig.species] ?? 0.145);
      const width = height * 0.7;
      if (Math.abs(canvasX - point.x) <= width * 0.55 && canvasY <= point.y + height * 0.15
        && canvasY >= point.y - height) {
        return { type: 'bird', treeId: bird.treeId, birdId: bird.id, branchId: bird.branchId };
      }
    }
    for (const layout of lastLayouts) {
      for (const point of layout.branchPoints) {
        const hitR = Math.max(14, point.span * 0.55, layout.cellHeight * 0.035);
        if (Math.hypot(canvasX - point.x, canvasY - point.y) <= hitR) {
          return { type: 'branch', treeId: layout.id, branchId: point.branchId };
        }
      }
    }
    for (const layout of lastLayouts) {
      if (canvasX >= layout.spriteX && canvasX <= layout.spriteX + layout.spriteSize
        && canvasY >= layout.spriteY && canvasY <= layout.spriteY + layout.spriteSize) {
        return { type: 'tree', treeId: layout.id };
      }
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
    drawCelestial(snapshot, snapshot.phase < 0.5 ? ink : inkNight,
      snapshot.phase < 0.5 ? dayFactor * visual.sunAlpha : (1 - dayFactor) * visual.moonAlpha);

    const configById = Object.fromEntries(config.trees.map((tree) => [tree.id, tree]));
    const layoutInput = snapshot.trees.map((tree) => ({ ...tree, ...(configById[tree.id] ?? {}) }));
    const layouts = computeTreeLayout(layoutInput, canvas.width, canvas.height, { focusTreeId });
    lastLayouts = layouts;
    lastLayoutById = Object.fromEntries(layouts.map((layout) => [layout.id, layout]));
    const treeById = Object.fromEntries(snapshot.trees.map((tree) => [tree.id, tree]));

    for (const layout of layouts) {
      const tree = treeById[layout.id];
      const treeConfig = configById[layout.id] ?? tree;
      drawTreeLabel(layout, currentInk);
      const image = assets.get(layout.id)?.tree ?? legacy.tree;
      if (!drawTreeSprite(layout, image, dayFactor)) {
        context.fillStyle = css(currentInk, 0.48);
        context.textAlign = 'center';
        context.font = `${Math.max(10, layout.cellHeight * 0.04)}px ui-monospace, monospace`;
        context.fillText('贴图载入中…', layout.rootX, layout.cellY + layout.cellHeight * 0.52);
      }
      drawPitchOverlay(layout, currentInk, tree.birds, snapshot.simTime);
    }
    for (const bird of snapshot.birds) {
      const tree = treeById[bird.treeId];
      const layout = lastLayoutById[bird.treeId];
      const treeConfig = configById[bird.treeId];
      if (!tree || !layout || !treeConfig) continue;
      drawBirdSprite(treeConfig, layout, bird, birdPoint(layout, tree, bird), snapshot.simTime);
    }
  }

  return {
    render, flash, resize, hitTest,
    setFocusTree, getFocusTree, toggleFocusTree,
  };
}
