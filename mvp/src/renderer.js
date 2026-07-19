// mvp/src/renderer.js —— duotone-riso 双色版画渲染器（贴图版，N 树数据驱动）。
// 接口契约（不变）：createRenderer(canvas, config) → { render(snapshot) }；
// 另提供可选 flash(birdId)（发声瞬间反馈）与 resize()，不破坏契约。
//
// 树数量彻底由快照驱动：snapshot.trees[]（≥2）逐树绘制，xOffset/mirror/drawScale
// 全部消费 config.trees 契约字段，渲染器不发明布局。树/地面线/riso 肌理全部来自
// 基准图抠制的 alpha 贴图（mvp/assets/），运行时按 config.visual 三 token 重新上色：
// 白昼 ink 靛蓝树，夜晚浅纸色树（双色反转），accent 橙红只给鸟。
// 帧内只做填色 + drawImage 合成，无逐像素计算。

import { CONFIG } from './config.js';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smoothstep = (t) => { const x = clamp(t); return x * x * (3 - 2 * x); };

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const css = ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`贴图加载失败: ${src}`));
    img.src = src;
  });
}

// alpha 贴图（白色+alpha）→ 指定色相版本（离屏一次性）
function tintImage(img, rgb) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = css(rgb);
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

// 树布局（纯函数，node 可测）：快照 trees[]（N≥2，数量/间距由 config 契约决定）→
// 每树的绘制锚点与缩放。锚点 = 画布中心 + xOffset×画布高，与树根（anchorX/anchorY）对齐。
export function computeTreeLayout(trees, W, H, V, imgW, imgH) {
  return trees.map((tree) => {
    const scale = (H * V.treeHeightRatio * (tree.drawScale ?? 1)) / imgH;
    return {
      id: tree.id,
      mirror: !!tree.mirror,
      scale,
      dw: imgW * scale,
      dh: imgH * scale,
      anchorPx: W / 2 + tree.xOffset * H,
    };
  });
}

export function createRenderer(canvas, config = CONFIG) {
  const V = config.visual;
  const g = canvas.getContext('2d');
  const PAPER = hexToRgb(V.paper);
  const INK = hexToRgb(V.ink);
  const ACCENT = hexToRgb(V.accent);
  const PAPER_NIGHT = hexToRgb(V.paperNight);
  const INK_NIGHT = hexToRgb(V.inkNight);

  let treeDay = null;
  let treeNight = null;
  let birdPerched = null; // { accent, light }
  let birdFly = null;
  let ready = false;
  const flashes = new Map(); // birdId -> 发声时刻（simTime）
  let lastSim = 0;
  const lastPos = new Map(); // birdId -> 上一帧 x（飞鸟朝向）

  Promise.all([
    loadImage(V.treeImage),
    loadImage(V.birdPerchedImage),
    loadImage(V.birdFlyImage),
  ]).then(([treeImg, perchImg, flyImg]) => {
    treeDay = tintImage(treeImg, INK);
    treeNight = tintImage(treeImg, INK_NIGHT);
    birdPerched = { accent: tintImage(perchImg, ACCENT), light: tintImage(perchImg, INK_NIGHT) };
    birdFly = { accent: tintImage(flyImg, ACCENT), light: tintImage(flyImg, INK_NIGHT) };
    ready = true;
  }).catch((err) => console.error(err));

  // 纸底颗粒 tile（昼 ink 点 / 夜浅纸点）
  function makeGrainTile(color) {
    const size = 160;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const x = c.getContext('2d');
    const rng = mulberry32(97);
    x.fillStyle = css(color);
    for (let i = 0; i < 420; i += 1) {
      x.beginPath();
      x.arc(rng() * size, rng() * size, 0.3 + rng() * 1.1, 0, Math.PI * 2);
      x.fill();
    }
    return c;
  }
  const grainDay = makeGrainTile(INK);
  const grainNight = makeGrainTile(PAPER);

  // ---- 日月（riso 网点天体）：日=ink 淡轮，月=纸色圆盘+轻晕；随尺寸惰性重建 ----
  let discs = null;
  function makeDisc(color, radiusPx, halo) {
    const R = Math.ceil(radiusPx * 2.2);
    const c = document.createElement('canvas');
    c.width = R * 2; c.height = R * 2;
    const x = c.getContext('2d');
    const rng = mulberry32(41);
    x.fillStyle = css(color);
    x.beginPath();
    x.arc(R, R, radiusPx, 0, Math.PI * 2);
    x.fill();
    // 网点咬出 riso 颗粒
    x.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < V.celestialGrainDots; i += 1) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radiusPx;
      x.beginPath();
      x.arc(R + Math.cos(a) * r, R + Math.sin(a) * r, 0.4 + rng() * 1.2, 0, Math.PI * 2);
      x.fill();
    }
    x.globalCompositeOperation = 'source-over';
    if (halo) { // 轻网点晕
      for (let i = 0; i < V.celestialGrainDots; i += 1) {
        const a = rng() * Math.PI * 2;
        const r = radiusPx * (1.08 + rng() * 0.5);
        x.globalAlpha = 0.25 * (1 - (r / radiusPx - 1.08) / 0.5);
        x.beginPath();
        x.arc(R + Math.cos(a) * r, R + Math.sin(a) * r, 0.5 + rng() * 1.4, 0, Math.PI * 2);
        x.fill();
      }
      x.globalAlpha = 1;
    }
    return c;
  }
  function ensureDiscs(H) {
    if (discs && discs.H === H) return;
    const r = H * V.celestialRadiusRatio;
    discs = { H, sun: makeDisc(INK, r, false), moon: makeDisc(INK_NIGHT, r, true) };
  }

  // 天体轨迹：白昼太阳走前半弧（左升右落），夜晚月亮走后半弧
  function drawCelestial(snapshot, dayFactor, H, horizonY) {
    ensureDiscs(H);
    const W = canvas.width;
    const isDay = snapshot.phase < 0.5;
    const frac = isDay ? snapshot.phase / 0.5 : (snapshot.phase - 0.5) / 0.5;
    const angle = Math.PI * (1 - frac);
    const cx = W / 2 - Math.cos(angle) * W * V.celestialArcSpanRatio;
    const cy = horizonY - Math.sin(angle) * H * V.celestialArcHeightRatio;
    const disc = isDay ? discs.sun : discs.moon;
    const alpha = isDay ? dayFactor * V.sunAlpha : (1 - dayFactor) * V.moonAlpha;
    if (alpha <= 0.01) return;
    g.globalAlpha = alpha;
    g.drawImage(disc, cx - disc.width / 2, cy - disc.height / 2);
    g.globalAlpha = 1;
  }

  function drawBird(bird, simTime, H, horizonY, trunkX) {
    const px = canvas.width / 2 + bird.pos.x * H;
    const py = horizonY - bird.pos.y * H;
    const prevX = lastPos.get(bird.id) ?? px;
    lastPos.set(bird.id, px);

    const flashAt = flashes.get(bird.id);
    const fAge = flashAt === undefined ? Infinity : simTime - flashAt;
    const fEnv = fAge < V.flashSeconds ? 1 - fAge / V.flashSeconds : 0;
    const eased = smoothstep(fEnv);

    const perched = bird.state === 'perched';
    const sprite = perched ? birdPerched : birdFly;
    const drawH = H * (perched ? V.birdPerchedDrawRatio : V.birdFlyDrawRatio)
      * (1 + (V.flashScale - 1) * eased);
    const drawW = drawH * (sprite.accent.width / sprite.accent.height);
    // 朝向：栖鸟面向自家树干（sprite 默认朝左），飞鸟沿运动方向（sprite 默认朝右）
    const flip = perched ? bird.pos.x < trunkX : (px - prevX) < 0;

    g.save();
    g.translate(px, py);
    if (flip) g.scale(-1, 1);
    // 栖鸟锚在爪部（贴近枝线），飞鸟锚在身体中心
    const ax = perched ? -drawW / 2 : -drawW / 2;
    const ay = perched ? -drawH * 0.92 : -drawH / 2;
    g.drawImage(sprite.accent, ax, ay, drawW, drawH);
    if (eased > 0) {
      g.globalAlpha = eased * V.flashBrighten;
      g.drawImage(sprite.light, ax, ay, drawW, drawH);
      g.globalAlpha = 1;
    }
    g.restore();
  }

  function resize() { /* 贴图逐帧按当前画布尺寸绘制，无需重建 */ }

  function flash(birdId) {
    flashes.set(birdId, lastSim);
  }

  function render(snapshot) {
    lastSim = snapshot.simTime;
    const W = canvas.width;
    const H = canvas.height;
    // 昼夜只动纸底：dayFactor 1=白昼，0=夜（黎明/黄昏平滑过渡）
    const dayFactor = smoothstep((snapshot.daylight - V.nightEdge) / V.transitionSpan);

    g.fillStyle = css(mix(PAPER_NIGHT, PAPER, dayFactor));
    g.fillRect(0, 0, W, H);
    g.globalAlpha = V.paperGrainAlpha;
    g.fillStyle = g.createPattern(dayFactor > 0.5 ? grainDay : grainNight, 'repeat');
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    if (!ready) return;

    // 树贴图（N 树等大并排，布局由 computeTreeLayout 数据驱动）：锚点对齐各自树根，昼 ink / 夜浅纸色
    const horizonY = H * V.horizonRatio;
    for (const L of computeTreeLayout(snapshot.trees, W, H, V, treeDay.width, treeDay.height)) {
      g.save();
      g.translate(L.anchorPx, 0);
      if (L.mirror) g.scale(-1, 1);
      const dx = -V.anchorX * L.scale;
      const dy = horizonY - V.anchorY * L.scale;
      g.globalAlpha = 1 - dayFactor;
      g.drawImage(treeNight, dx, dy, L.dw, L.dh);
      g.globalAlpha = dayFactor;
      g.drawImage(treeDay, dx, dy, L.dw, L.dh);
      g.restore();
    }
    g.globalAlpha = 1;

    drawCelestial(snapshot, dayFactor, H, horizonY); // 日月（riso 网点，三 token 内）

    const trunkXOf = Object.fromEntries(snapshot.trees.map((t) => [t.id, t.xOffset]));
    for (const bird of snapshot.birds) drawBird(bird, snapshot.simTime, H, horizonY, trunkXOf[bird.treeId] ?? 0);
  }

  return { render, flash, resize };
}
