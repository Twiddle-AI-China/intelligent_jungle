// 绘本插画 · 暖阳田园 —— 生态音序器 2D canvas 程序化渲染器。
// 自包含：无依赖、无外部资源，天空/丘陵/树/鸟/粒子全部由 canvas 路径程序化生成。
//
// 契约（与 src/world.js 对齐，全部字段缺失时都有兜底）：
//   world.trees[i]  = { id, hue, foliage, pest, slot:{x,y}, speciesName, treeName, role,
//                       branches: [{ branch, step, x, y, midi }] }   // 归一化世界坐标
//   world.flocks[i] = { id, hue, homeTreeId, population, flyingCount, perchedCount }
//   world.boids[i]  = { id, flockId, x, y, vx, vy, perched: null | { treeId, branch, step } }
//   world.pulsePosition (0-1 扫描相位) · world.dayPhase (0-1, 0.25=正午 0.75=午夜)
//   world.season (0-3 春夏秋冬) · world.seed · world.config.{canopyWidth, canopyHeight, stepsPerLoop}
//   world.interaction = null | { mode:'guide', x, y }
//   camera = { cx, cy, scale, u }（u=0 四树全景；u→1 贴近 focusFlockId 对应的那棵树）
//
// API：const r = new StorybookRenderer(canvas);
//       r.draw(world, camera, focusFlockId, dt);  // 每帧
//       r.resize();                               // 窗口尺寸变化时（处理 devicePixelRatio）
//
// 注意：本模块绝不调用 world.random（那是模拟层的确定性种子），
// 所有视觉随机性来自内部以 world.seed 派生的独立 PRNG。

const TAU = Math.PI * 2;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
// 环形距离（相位 0-1 或步号 0-steps 通用）
const wrapDist = (a, b, period) => { let d = Math.abs(a - b) % period; return d > period / 2 ? period - d : d; };
// 无状态伪随机（按 id 取固定随机量，避免每帧建 PRNG）
const hash01 = (n) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (midi) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

// ——— 天空关键帧（dayPhase: 0=黎明 0.25=正午 0.5=黄昏 0.75=午夜）———
const SKY_KEYS = [
  { p: 0.00, top: [263, 36, 62], mid: [338, 55, 73], hor: [26, 90, 76] },   // 黎明：粉金
  { p: 0.25, top: [207, 64, 72], mid: [201, 68, 83], hor: [46, 84, 89] },   // 正午：淡蓝暖白
  { p: 0.50, top: [252, 38, 52], mid: [16, 76, 63], hor: [34, 97, 67] },    // 黄昏：金橙
  { p: 0.75, top: [248, 48, 15], mid: [253, 42, 23], hor: [268, 34, 31] },  // 午夜：深蓝紫
];

function skyColors(phase, out) {
  let i = 0;
  while (i < SKY_KEYS.length && SKY_KEYS[i].p <= phase) i += 1;
  const k2 = SKY_KEYS[i % SKY_KEYS.length];
  const k1 = SKY_KEYS[(i - 1 + SKY_KEYS.length) % SKY_KEYS.length];
  const span = (k2.p - k1.p + 1) % 1 || 1;
  const t = smoothstep(0, 1, ((phase - k1.p + 1) % 1) / span);
  for (let c = 0; c < 3; c += 1) {
    const a = c === 0 ? k1.top : c === 1 ? k1.mid : k1.hor;
    const b = c === 0 ? k2.top : c === 1 ? k2.mid : k2.hor;
    const h0 = a[0]; let h1 = b[0];
    if (h1 - h0 > 180) h1 -= 360; else if (h0 - h1 > 180) h1 += 360;
    out[c * 3] = lerp(h0, h1, t);
    out[c * 3 + 1] = lerp(a[1], b[1], t);
    out[c * 3 + 2] = lerp(a[2], b[2], t);
  }
  return out;
}

// ——— 四季调色板（颜色字符串全部预构建，热循环零字符串分配）———
const SEASONS = [
  { // 春：新绿 + 花
    leaf: ['hsl(96 54% 55%)', 'hsl(108 50% 46%)', 'hsl(84 60% 62%)', 'hsl(118 44% 40%)'],
    blossom: ['hsl(350 76% 86%)', 'hsl(344 70% 79%)', 'hsl(42 92% 88%)'],
    bud: 'hsl(345 70% 82%)',
    far: ['hsl(102 34% 78%)', 'hsl(97 38% 69%)'],
    mid: ['hsl(96 44% 63%)', 'hsl(92 42% 50%)'],
    meadow: ['hsl(94 52% 57%)', 'hsl(88 46% 36%)'],
    grass: ['hsl(92 56% 42%)', 'hsl(104 48% 36%)', 'hsl(80 60% 52%)'],
    flower: ['hsl(350 80% 80%)', 'hsl(45 95% 74%)', 'hsl(280 58% 82%)'],
    drift: { kind: 'petal', colors: ['hsl(348 78% 87%)', 'hsl(344 72% 81%)', 'hsl(40 90% 89%)'] },
  },
  { // 夏：浓绿
    leaf: ['hsl(122 40% 38%)', 'hsl(133 42% 32%)', 'hsl(106 46% 43%)', 'hsl(142 36% 28%)'],
    blossom: ['hsl(55 85% 80%)', 'hsl(95 60% 70%)', 'hsl(20 80% 78%)'],
    bud: 'hsl(95 50% 60%)',
    far: ['hsl(126 28% 68%)', 'hsl(122 30% 58%)'],
    mid: ['hsl(121 36% 50%)', 'hsl(116 38% 40%)'],
    meadow: ['hsl(118 44% 42%)', 'hsl(110 42% 28%)'],
    grass: ['hsl(118 50% 34%)', 'hsl(130 44% 28%)', 'hsl(100 52% 42%)'],
    flower: ['hsl(52 92% 72%)', 'hsl(8 78% 72%)', 'hsl(300 40% 80%)'],
    drift: { kind: 'seed', colors: ['hsl(60 30% 92%)', 'hsl(80 25% 88%)', 'hsl(50 35% 94%)'] },
  },
  { // 秋：金橙
    leaf: ['hsl(38 76% 55%)', 'hsl(24 72% 50%)', 'hsl(48 82% 58%)', 'hsl(14 62% 45%)'],
    blossom: ['hsl(30 70% 60%)', 'hsl(45 80% 65%)', 'hsl(15 65% 55%)'],
    bud: 'hsl(35 75% 55%)',
    far: ['hsl(46 42% 73%)', 'hsl(42 44% 62%)'],
    mid: ['hsl(39 52% 58%)', 'hsl(34 50% 46%)'],
    meadow: ['hsl(36 56% 52%)', 'hsl(28 50% 36%)'],
    grass: ['hsl(38 60% 44%)', 'hsl(28 54% 36%)', 'hsl(48 64% 52%)'],
    flower: ['hsl(35 70% 55%)', 'hsl(20 65% 50%)', 'hsl(50 75% 60%)'],
    drift: { kind: 'leaf', colors: ['hsl(30 75% 55%)', 'hsl(18 68% 48%)', 'hsl(44 80% 58%)'] },
  },
  { // 冬：灰蓝白
    leaf: ['hsl(160 10% 46%)', 'hsl(180 8% 52%)', 'hsl(200 10% 60%)', 'hsl(150 8% 40%)'],
    blossom: ['hsl(0 0% 92%)', 'hsl(210 20% 88%)', 'hsl(200 15% 84%)'],
    bud: 'hsl(20 28% 46%)',
    far: ['hsl(210 20% 85%)', 'hsl(208 18% 77%)'],
    mid: ['hsl(206 16% 78%)', 'hsl(204 14% 66%)'],
    meadow: ['hsl(200 15% 84%)', 'hsl(206 12% 68%)'],
    grass: ['hsl(90 12% 52%)', 'hsl(60 10% 44%)', 'hsl(200 12% 66%)'],
    flower: ['hsl(0 0% 90%)', 'hsl(210 15% 85%)', 'hsl(30 20% 60%)'],
    drift: { kind: 'snow', colors: ['hsl(0 0% 97%)', 'hsl(210 25% 94%)', 'hsl(220 20% 90%)'] },
  },
];

const BARK = { fill: 'hsl(27 38% 36%)', dark: 'hsl(24 34% 26%)', light: 'hsl(30 40% 48%)', limb: 'hsl(26 36% 30%)' };
const SNOW_CAP = 'hsla(0 0% 96% / 0.55)';
const PEST_COLOR = 'hsl(20 35% 22%)';
const LABEL_FONT = '12px "Iowan Old Style", "Songti SC", "STKaiti", Georgia, serif';
const NOTE_FONT = '11px "Iowan Old Style", "Songti SC", Georgia, serif';

export class StorybookRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.time = 0;

    // ——— 每帧复用的暂存（避免热循环分配）———
    this._sky = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // 天空关键帧插值结果
    this._order = [0, 1, 2, 3];              // 树绘制顺序（按 slot.y 远→近）
    this._glowSlots = [];                    // 夜间需要二次发光的花苞
    for (let i = 0; i < 96; i += 1) this._glowSlots.push({ x: 0, y: 0, r: 0, act: 0, hue: 0 });
    this._glowCount = 0;

    // ——— 缓存 ———
    this._treeSkels = new Map();   // tree.id -> 程序化树形骨架（种子一致才复用）
    this._limbCache = new Map();   // tree.id -> { ref, rows }（branches 引用变才重建）
    this._birdStyles = new Map();  // flock.id -> 预构建颜色串
    this._birdState = new Map();   // boid.id -> { angle, wing }（朝向平滑/振翅相位）
    this._assetsSeed = -1;         // 静态景物（丘陵/草/云/星/粒子）的种子版本
    this._paperPattern = null;

    this._paper = this._makePaper();
    this.resize();
  }

  resize() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const cssW = Math.max(1, Math.round(rect.width || canvas.clientWidth || 800));
    const cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 600));
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr;
    this.w = cssW;
    this.h = cssH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ———————————————————————————— 主入口 ————————————————————————————
  draw(world, camera, focusFlockId, dt) {
    if (!world || !this.ctx) return;
    if ((this.canvas.clientWidth | 0) !== this.w || (this.canvas.clientHeight | 0) !== this.h) this.resize();
    const ctx = this.ctx;
    const w = this.w; const h = this.h;
    dt = clamp(dt ?? 0.016, 0, 0.1);
    this.time += dt;
    const t = this.time;

    // camera 与坐标映射（与 app.js 的 screenToWorld 契约一致）
    const cam = camera || { cx: 0.5, cy: 0.5, scale: 1, u: 0 };
    const scale = Math.max(0.05, cam.scale || 1);
    const u = clamp(cam.u ?? (scale - 1) / 1.6);
    const cx = cam.cx ?? 0.5; const cy = cam.cy ?? 0.5;
    const sx = scale * w; const sy = scale * h; const su = scale * Math.min(w, h);
    this._sx = sx; this._sy = sy; this._su = su;

    const trees = world.trees || [];
    const config = world.config || {};
    const cw = config.canopyWidth ?? 0.16;
    const ch = config.canopyHeight ?? 0.3;
    const steps = config.stepsPerLoop ?? 16;
    const season = ((Math.round(world.season ?? 0) % 4) + 4) % 4;
    const pal = SEASONS[season];
    const dayPhase = (((world.dayPhase ?? 0.3) % 1) + 1) % 1;
    const pulse = (((world.pulsePosition ?? 0) % 1) + 1) % 1;
    const daylight = 0.5 + 0.5 * Math.cos((dayPhase - 0.25) * TAU);
    const night = 1 - daylight;
    const dusk = Math.exp(-((wrapDist(dayPhase, 0.5, 1) / 0.1) ** 2)) + 0.7 * Math.exp(-((wrapDist(dayPhase, 0, 1) / 0.08) ** 2));

    // 焦点树
    let focusTree = null;
    if (focusFlockId != null) {
      focusTree = trees.find((tr) => tr.id === focusFlockId) ?? trees[focusFlockId] ?? null;
    }

    // 布局自适应：后排树行/前排树行决定丘陵结构（2×2 或其他布局都成立）
    let minY = 1; let maxY = 0;
    for (const tr of trees) { if (tr.slot.y < minY) minY = tr.slot.y; if (tr.slot.y > maxY) maxY = tr.slot.y; }
    if (!trees.length) { minY = 0.3; maxY = 0.7; }
    const backRowY = minY; const meadowTop = (minY + maxY) / 2 + 0.03;

    // 静态景物（按 world.seed 生成一次）
    this._ensureAssets((world.seed ?? 1) >>> 0);

    // 扫描光带的世界 x：全景扫整个世界；贴近时收缩到焦点树的步进区间（与花苞亮起的节拍对齐）
    let sweepX = pulse;
    if (focusTree) {
      const localX = focusTree.slot.x - cw / 2 + pulse * cw;
      sweepX = lerp(pulse, localX, smoothstep(0.15, 0.8, u));
    }
    const gustAt = (nx) => Math.exp(-(((nx - sweepX) / 0.08) ** 2));

    // 花苞激活（音乐节拍：第 s 步在 pulsePosition = s/steps 时触发）
    const stepFloat = pulse * steps;

    const px = (nx) => (nx - cx) * sx + w / 2;
    const py = (ny) => (ny - cy) * sy + h / 2;

    // ═══ 1. 天空 ═══
    skyColors(dayPhase, this._sky);
    const sk = this._sky;
    const skyG = ctx.createLinearGradient(0, 0, 0, h);
    skyG.addColorStop(0, `hsl(${sk[0]} ${sk[1]}% ${sk[2]}%)`);
    skyG.addColorStop(0.55, `hsl(${sk[3]} ${sk[4]}% ${sk[5]}%)`);
    skyG.addColorStop(1, `hsl(${sk[6]} ${sk[7]}% ${sk[8]}%)`);
    ctx.fillStyle = skyG;
    ctx.fillRect(0, 0, w, h);

    // ═══ 2. 太阳 / 月亮 ═══
    this._drawSunMoon(dayPhase, daylight, night, dusk, px, py);

    // ═══ 3. 云 ═══
    this._drawClouds(daylight, night, px, py, su);

    // ═══ 4. 远山 / 丘陵 / 草地 ═══
    this._drawHills(pal, backRowY, meadowTop, px, py);

    // ═══ 5. 扫描光带（一缕风/光晕，不是生硬竖线）═══
    this._drawScanBand(sweepX, u, night, dusk, px, py, sx);

    // ═══ 6. 四棵树（远→近）═══
    this._glowCount = 0;
    const order = this._order;
    order.length = trees.length;
    for (let i = 0; i < trees.length; i += 1) order[i] = i;
    order.sort((a, b) => trees[a].slot.y - trees[b].slot.y);
    for (let i = 0; i < order.length; i += 1) {
      const tree = trees[order[i]];
      const isFocus = focusTree != null && tree.id === focusTree.id;
      const fade = focusTree != null && !isFocus ? 1 - u * 0.72 : 1;
      if (fade < 0.04) continue;
      // 树冠中心出屏则整棵跳过
      const ccx = px(tree.slot.x); const ccy = py(tree.slot.y - ch * 0.6);
      const margin = cw * 1.2 * sx + 80;
      if (ccx < -margin || ccx > w + margin || ccy < -margin || ccy > h + margin * 2) continue;
      const gust = gustAt(tree.slot.x);
      const sway = Math.sin(t * 0.9 + tree.id * 1.7) * (0.5 + 0.9 * gust);
      this._drawTree(world, tree, pal, season, {
        t, dt, u, fade, isFocus, sway, gust, stepFloat, steps, night, cw, ch, px, py, sx, sy, su,
      });
    }

    // ═══ 7. 草与花（前层，盖过树根）═══
    this._drawGrass(pal, season, meadowTop, backRowY, gustAt, t, px, py, sx, sy, su);

    // ═══ 8. 鸟 ═══
    this._drawBirds(world, focusTree, u, t, dt, px, py);

    // ═══ 9. 季节飘浮粒子（花瓣/蒲公英/落叶/雪）═══
    this._drawDrifters(pal, t, dt, px, py, su);

    // ═══ 10. 光照纱罩（黄昏暖橙 / 夜晚蓝紫，统一画面色温）═══
    if (dusk > 0.02) { ctx.fillStyle = `rgba(255 140 60 / ${0.1 * Math.min(1, dusk)})`; ctx.fillRect(0, 0, w, h); }
    if (night > 0.02) { ctx.fillStyle = `hsla(235 45% 12% / ${0.3 * night})`; ctx.fillRect(0, 0, w, h); }

    // ═══ 11. 发光层（纱罩之上才透得出来）：星 / 夜间花苞 / 萤火虫 / 昼间光尘 ═══
    this._drawGlowPass(night, daylight, t, px, py);

    // ═══ 12. 引导手势光晕 ═══
    const inter = world.interaction;
    if (inter && inter.mode === 'guide') {
      const ix = px(inter.x); const iy = py(inter.y);
      const pulseR = 10 + 5 * Math.sin(t * 5);
      ctx.save();
      ctx.strokeStyle = 'hsla(45 90% 88% / 0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ix, iy, pulseR, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'hsla(45 90% 88% / 0.16)';
      ctx.beginPath(); ctx.arc(ix, iy, pulseR + 9, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // ═══ 13. UI 层（音名 / 树名，字号不随镜头缩放）═══
    this._drawLabels(trees, focusTree, u, px, py);

    // ═══ 14. 绘本框景：暗角 + 纸纹 ═══
    const vg = ctx.createRadialGradient(w / 2, h * 0.42, Math.min(w, h) * 0.45, w / 2, h * 0.5, Math.max(w, h) * 0.78);
    vg.addColorStop(0, 'rgba(64 38 12 / 0)');
    vg.addColorStop(1, 'rgba(64 38 12 / 0.18)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = this._paperPattern ?? (this._paperPattern = ctx.createPattern(this._paper, 'repeat'));
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ———————————————————————————— 天体 ————————————————————————————
  _drawSunMoon(dayPhase, daylight, night, dusk, px, py) {
    const ctx = this.ctx;
    // 太阳：正午在天顶，午夜在地平线下
    const sunTheta = (dayPhase - 0.25) * TAU;
    const sunX = 0.5 + 0.46 * Math.sin(sunTheta);
    const sunY = 0.66 - 0.52 * Math.cos(sunTheta);
    if (sunY < 0.82) {
      const x = px(sunX); const y = py(sunY);
      const glowR = Math.min(this.w, this.h) * (0.22 + dusk * 0.1);
      const g = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      const warm = dusk > 0.4 ? '30 100% 68%' : '48 100% 78%';
      g.addColorStop(0, `hsla(${warm} / ${0.55 * Math.max(daylight, dusk * 0.7)})`);
      g.addColorStop(1, 'hsla(48 100% 78% / 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - glowR, y - glowR, glowR * 2, glowR * 2);
      const r = Math.min(this.w, this.h) * 0.032;
      ctx.fillStyle = `hsl(48 100% ${82 + dusk * 4}%)`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = 'hsla(45 100% 92% / 0.9)';
      ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, TAU); ctx.fill();
    }
    // 月亮：午夜在天顶
    const moonTheta = (dayPhase - 0.75) * TAU;
    const moonX = 0.5 + 0.42 * Math.sin(moonTheta);
    const moonY = 0.62 - 0.5 * Math.cos(moonTheta);
    if (night > 0.25 && moonY < 0.8) {
      const x = px(moonX); const y = py(moonY);
      const r = Math.min(this.w, this.h) * 0.026;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, `hsla(55 40% 85% / ${0.3 * night})`);
      g.addColorStop(1, 'hsla(55 40% 85% / 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
      ctx.fillStyle = `hsl(50 30% 90% / ${0.55 + night * 0.4})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      // 月牙阴影
      ctx.fillStyle = `hsl(248 40% 20% / ${0.5 * night})`;
      ctx.beginPath(); ctx.arc(x + r * 0.38, y - r * 0.18, r * 0.86, 0, TAU); ctx.fill();
    }
  }

  _drawClouds(daylight, night, px, py, su) {
    const ctx = this.ctx;
    const alpha = 0.22 + daylight * 0.3 + night * 0.06;
    for (const c of this._clouds) {
      const x = px((((c.x + this.time * c.speed) % 1.3) + 1.3) % 1.3 - 0.15);
      const y = py(c.y);
      const s = c.s * su;
      ctx.fillStyle = `hsla(0 0% 100% / ${alpha * 0.55})`;
      ctx.beginPath();
      for (const p of c.puffs) ctx.ellipse(x + p.dx * s, y + p.dy * s * 0.6 + s * 0.06, p.r * s, p.r * s * 0.52, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(0 0% 100% / ${alpha})`;
      ctx.beginPath();
      for (const p of c.puffs) ctx.ellipse(x + p.dx * s, y + p.dy * s * 0.6, p.r * s * 0.92, p.r * s * 0.5, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ———————————————————————————— 地貌 ————————————————————————————
  _drawHills(pal, backRowY, meadowTop, px, py) {
    // 三层地貌：远山脊（后排树后）→ 中丘（后排树站在脊上）→ 前草地（前排树）
    this._hillLayer(pal.far, backRowY - 0.02, this._bumpsFar, px, py);
    this._hillLayer(pal.mid, backRowY + 0.015, this._bumpsMid, px, py);
    this._hillLayer(pal.meadow, meadowTop, this._bumpsMeadow, px, py);
    // 地平线的柔光（暖阳田园的空气感）
    const ctx = this.ctx;
    const hz = ctx.createLinearGradient(0, py(backRowY - 0.1), 0, py(meadowTop + 0.06));
    hz.addColorStop(0, 'hsla(45 90% 88% / 0)');
    hz.addColorStop(0.5, 'hsla(45 90% 88% / 0.14)');
    hz.addColorStop(1, 'hsla(45 90% 88% / 0)');
    ctx.fillStyle = hz;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  _hillLayer(colors, baseY, bumps, px, py) {
    const ctx = this.ctx;
    const top = py(baseY - 0.3); const bottom = this.h + 4;
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, colors[0]);
    g.addColorStop(1, colors[1]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-4, bottom);
    for (let i = 0; i <= 16; i += 1) {
      const nx = i / 16;
      let y = baseY;
      for (let b = 0; b < bumps.length; b += 1) {
        const bp = bumps[b];
        const d = (nx - bp.c) / bp.w;
        y -= bp.a * Math.exp(-d * d);
      }
      ctx.lineTo(px(nx), py(y));
    }
    ctx.lineTo(this.w + 4, bottom);
    ctx.closePath();
    ctx.fill();
  }

  // ———————————————————————————— 扫描光带 ————————————————————————————
  _drawScanBand(sweepX, u, night, dusk, px, py, sx) {
    const ctx = this.ctx;
    const x = px(sweepX);
    const bw = Math.max(36, 0.055 * sx);
    const strength = (0.16 + night * 0.06 + dusk * 0.05) * (1 - u * 0.25);
    // 主光晕
    const g = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
    g.addColorStop(0, 'rgba(255 205 140 / 0)');
    g.addColorStop(0.5, `rgba(255 205 140 / ${strength})`);
    g.addColorStop(1, 'rgba(255 205 140 / 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - bw, 0, bw * 2, this.h);
    // 几缕倾斜的风线
    ctx.save();
    ctx.strokeStyle = `rgba(255 225 180 / ${strength * 0.5})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i += 1) {
      const off = (hash01(i * 3.3) - 0.5) * bw * 1.2;
      const yy = ((this.time * (0.05 + i * 0.023) + hash01(i * 7.7)) % 1.2) * this.h - this.h * 0.1;
      ctx.beginPath();
      ctx.moveTo(x + off - 14, yy + 40);
      ctx.quadraticCurveTo(x + off, yy, x + off + 14, yy - 40);
      ctx.stroke();
    }
    ctx.restore();
    // 地面落光
    const gy = py(0.75);
    const rg = ctx.createRadialGradient(x, gy, 0, x, gy, bw * 1.4);
    rg.addColorStop(0, `rgba(255 215 150 / ${strength * 0.55})`);
    rg.addColorStop(1, 'rgba(255 215 150 / 0)');
    ctx.fillStyle = rg;
    ctx.fillRect(x - bw * 1.4, gy - bw * 0.5, bw * 2.8, bw);
  }

  // ———————————————————————————— 树 ————————————————————————————
  _treeSkeleton(world, tree, cw, ch) {
    const seedKey = (world.seed ?? 1) >>> 0;
    let sk = this._treeSkels.get(tree.id);
    if (sk && sk.seedKey === seedKey && sk.cw === cw && sk.ch === ch) return sk;
    const rng = mulberry32((seedKey ^ Math.imul(tree.id + 1, 0x9e3779b1)) >>> 0);
    const slot = tree.slot;

    // 主干：7 段折线带弯曲，从下往上逐渐变细
    const trunkH = ch * 1.08;
    const bend = (rng() - 0.5) * cw * 0.26;
    const bend2 = (rng() - 0.5) * cw * 0.14;
    const pts = [];
    for (let i = 0; i <= 6; i += 1) {
      const tt = i / 6;
      pts.push({
        x: slot.x + bend * Math.sin(tt * 2.2) * tt + bend2 * tt * tt,
        y: slot.y + 0.006 - trunkH * tt,
        hw: lerp(cw * 0.05, cw * 0.011, Math.pow(tt, 0.8)),
      });
    }
    // 角色决定树冠轮廓：bass 宽矮，shimmer 高瘦（仍罩住全部枝干行）
    const roleWide = tree.role === 'bass' ? 1.14 : tree.role === 'shimmer' ? 0.88 : 1.0;
    const roleTall = tree.role === 'shimmer' ? 1.14 : tree.role === 'bass' ? 0.9 : 1.0;
    const crown = {
      cx: slot.x + bend * 0.55,
      cy: slot.y - ch * 0.6,
      rx: cw * 0.62 * roleWide,
      ry: ch * 0.4 * roleTall,
    };
    // 叶团：中心大边缘小；tone 预绑季节色板索引；blossom 春季开花标记
    const blobs = [];
    for (let i = 0; i < 74; i += 1) {
      const ang = rng() * TAU;
      const rad = Math.sqrt(rng()) * 0.96;
      blobs.push({
        dx: Math.cos(ang) * crown.rx * rad,
        dy: Math.sin(ang) * crown.ry * rad * 0.92,
        r: lerp(cw * 0.075, cw * 0.15, rng()) * (1 - rad * 0.32),
        tone: (rng() * 4) | 0,
        rot: (rng() - 0.5) * 1.2,
        blossom: rng() < 0.2,
        swayAmp: 0.4 + rng() * 0.8,
      });
    }
    blobs.sort((a, b) => b.r - a.r); // 稀疏时先掉小叶团，大树仍成形
    // 虫斑：树冠/枝干上的不规则暗斑多边形
    const pestSpots = [];
    for (let i = 0; i < 14; i += 1) {
      const poly = [];
      for (let k = 0; k < 6; k += 1) poly.push(0.6 + rng() * 0.6);
      pestSpots.push({
        x: slot.x + (rng() - 0.5) * cw * 0.9,
        y: slot.y - ch * (0.3 + rng() * 0.62),
        r: cw * (0.016 + rng() * 0.02),
        rot: rng() * TAU,
        poly,
      });
    }
    // 枯枝（foliage 低/冬季显露）
    const twigs = [];
    for (let i = 0; i < 10; i += 1) {
      twigs.push({ rowPick: rng(), tt: 0.15 + rng() * 0.7, ang: -0.6 - rng() * 0.9, len: ch * (0.05 + rng() * 0.08), flip: rng() < 0.5 ? -1 : 1 });
    }
    // 树根鼓包与树干瘤节
    const roots = [];
    for (let i = 0; i < 3; i += 1) roots.push({ dx: (rng() - 0.5) * cw * 0.14, w: cw * (0.03 + rng() * 0.03) });
    const knot = { t: 0.25 + rng() * 0.35, side: rng() < 0.5 ? -1 : 1, r: cw * 0.014 };

    sk = { seedKey, cw, ch, pts, crown, blobs, pestSpots, twigs, roots, knot };
    this._treeSkels.set(tree.id, sk);
    return sk;
  }

  // 枝干行（音符行）几何：按 branch 分组，缓存到 branches 引用变化为止
  _limbRows(tree) {
    const cached = this._limbCache.get(tree.id);
    if (cached && cached.ref === tree.branches) return cached.rows;
    const sparse = [];
    for (const p of tree.branches || []) {
      let row = sparse[p.branch];
      if (!row) { row = sparse[p.branch] = { branch: p.branch, midi: p.midi, y: p.y, x0: p.x, x1: p.x }; }
      row.midi = p.midi; row.y = p.y;
      if (p.x < row.x0) row.x0 = p.x;
      if (p.x > row.x1) row.x1 = p.x;
    }
    const rows = sparse.filter(Boolean).sort((a, b) => b.y - a.y); // 低枝（低音）在前
    this._limbCache.set(tree.id, { ref: tree.branches, rows });
    return rows;
  }

  _drawTree(world, tree, pal, season, env) {
    const ctx = this.ctx;
    const { t, u, fade, isFocus, sway, stepFloat, steps, night, cw, ch, px, py, sx, sy, su } = env;
    const sk = this._treeSkeleton(world, tree, cw, ch);
    const rows = this._limbRows(tree);
    const slot = tree.slot;
    const winter = season === 3;
    const foliage = clamp(tree.foliage ?? 0.8);
    const zoomK = 1 + (isFocus ? u * 0.5 : 0); // 贴近时节点放大可见

    ctx.save();
    ctx.globalAlpha = fade;

    // ——— 飞鸟光环（飞着的鸟绕树的无形轨道，极淡）———
    const flock = (world.flocks || [])[tree.id];
    if (flock && flock.population > 0) {
      const flyRatio = (flock.flyingCount ?? 0) / Math.max(1, flock.population);
      if (flyRatio > 0.25) {
        ctx.strokeStyle = `hsla(${tree.hue} 70% 75% / ${(0.05 + flyRatio * 0.06) * fade})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(px(sk.crown.cx), py(sk.crown.cy), sk.crown.rx * 1.18 * sx, sk.crown.ry * 1.1 * sy, 0, 0, TAU);
        ctx.stroke();
      }
    }

    // ——— 主干（弯曲 tapered 多边形 + 树皮线 + 瘤节 + 根）———
    const pts = sk.pts;
    ctx.fillStyle = BARK.fill;
    ctx.beginPath();
    ctx.moveTo(px(pts[0].x - pts[0].hw), py(pts[0].y));
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(px(pts[i].x - pts[i].hw), py(pts[i].y));
    for (let i = pts.length - 1; i >= 0; i -= 1) ctx.lineTo(px(pts[i].x + pts[i].hw), py(pts[i].y));
    ctx.closePath();
    ctx.fill();
    // 向阳侧高光（固定左光，绘本风允许）
    ctx.strokeStyle = BARK.light;
    ctx.lineWidth = Math.max(0.8, pts[0].hw * 0.35 * sx);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      const lx = px(pts[i].x - pts[i].hw * 0.45); const ly = py(pts[i].y);
      if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
    }
    ctx.stroke();
    // 背阴侧树皮线
    ctx.strokeStyle = BARK.dark;
    ctx.lineWidth = Math.max(0.7, pts[0].hw * 0.22 * sx);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      const lx = px(pts[i].x + pts[i].hw * 0.4); const ly = py(pts[i].y);
      if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
    }
    ctx.stroke();
    // 瘤节
    const ki = Math.min(pts.length - 2, Math.floor(sk.knot.t * (pts.length - 1)));
    ctx.fillStyle = BARK.dark;
    ctx.beginPath();
    ctx.ellipse(px(pts[ki].x + sk.knot.side * pts[ki].hw * 0.4), py(pts[ki].y), sk.knot.r * su, sk.knot.r * 1.4 * su, 0.2, 0, TAU);
    ctx.fill();
    // 根
    ctx.fillStyle = BARK.fill;
    for (const r of sk.roots) {
      ctx.beginPath();
      ctx.ellipse(px(slot.x + r.dx), py(slot.y + 0.004), r.w * sx, r.w * 0.45 * sy, 0, Math.PI, TAU);
      ctx.fill();
    }

    // ——— 枝干（音符行）：穿过分叉点（鸟落点）的左右横枝 ———
    const swaySag = sway * 0.0016;
    const rowCount = Math.max(1, rows.length);
    for (let ri = 0; ri < rows.length; ri += 1) {
      const row = rows[ri];
      const rowFrac = rows.length <= 1 ? 0.5 : ri / (rowCount - 1);
      const ax = this._trunkXAtY(pts, row.y);
      const yRow = row.y;
      const ext = cw * 0.045;
      const sag = ch * 0.02 * (1 - rowFrac * 0.5) + swaySag;
      const lw = Math.max(1, cw * (0.014 + 0.02 * (1 - rowFrac)) * su);
      ctx.strokeStyle = BARK.limb;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px(row.x0), py(yRow));
      ctx.quadraticCurveTo(px((row.x0 + ax) / 2), py(yRow + sag), px(ax), py(yRow + 0.0015));
      ctx.quadraticCurveTo(px((ax + row.x1) / 2), py(yRow + sag), px(row.x1), py(yRow));
      // 枝梢微微上扬
      ctx.moveTo(px(row.x0), py(yRow));
      ctx.quadraticCurveTo(px(row.x0 - ext * 0.5), py(yRow - 0.003), px(row.x0 - ext), py(yRow - 0.006));
      ctx.moveTo(px(row.x1), py(yRow));
      ctx.quadraticCurveTo(px(row.x1 + ext * 0.5), py(yRow - 0.003), px(row.x1 + ext), py(yRow - 0.006));
      ctx.stroke();
      if (winter) { // 雪盖
        ctx.save();
        ctx.translate(0, -lw * 0.4);
        ctx.strokeStyle = SNOW_CAP;
        ctx.lineWidth = lw * 0.65;
        ctx.beginPath();
        ctx.moveTo(px(row.x0), py(yRow));
        ctx.quadraticCurveTo(px((row.x0 + ax) / 2), py(yRow + sag), px(ax), py(yRow + 0.0015));
        ctx.quadraticCurveTo(px((ax + row.x1) / 2), py(yRow + sag), px(row.x1), py(yRow));
        ctx.stroke();
        ctx.restore();
      }
    }

    // ——— 枯枝（稀疏或冬季可见）———
    const twigCount = Math.round((winter ? 1 : 1 - foliage) * sk.twigs.length);
    if (twigCount > 0 && rows.length) {
      ctx.strokeStyle = BARK.dark;
      ctx.lineWidth = Math.max(0.6, cw * 0.006 * su);
      ctx.beginPath();
      for (let i = 0; i < twigCount; i += 1) {
        const tw = sk.twigs[i];
        const row = rows[Math.min(rows.length - 1, Math.floor(tw.rowPick * rows.length))];
        const bx = lerp(row.x0, row.x1, tw.tt);
        ctx.moveTo(px(bx), py(row.y));
        ctx.quadraticCurveTo(
          px(bx + tw.flip * tw.len * 0.4), py(row.y + tw.ang * tw.len * 0.6),
          px(bx + tw.flip * tw.len * 0.7), py(row.y + tw.ang * tw.len),
        );
      }
      ctx.stroke();
    }

    // ——— 叶团（繁茂度决定密度；冬季稀疏；四季换色）———
    const density = winter ? 0.2 : 1;
    const n = Math.round(sk.blobs.length * foliage * density);
    const swayX = sway * 0.0035;
    for (let i = 0; i < n; i += 1) {
      const b = sk.blobs[i];
      const useBlossom = b.blossom && season === 0;
      ctx.fillStyle = useBlossom ? pal.blossom[b.tone % 3] : pal.leaf[b.tone];
      ctx.beginPath();
      ctx.ellipse(
        px(sk.crown.cx + b.dx + swayX * b.swayAmp),
        py(sk.crown.cy + b.dy + swayX * b.swayAmp * 0.3),
        Math.max(0.6, b.r * sx), Math.max(0.5, b.r * 0.78 * sy), b.rot, 0, TAU,
      );
      ctx.fill();
    }
    // 冬季树冠积雪
    if (winter && n > 0) {
      ctx.fillStyle = 'hsla(0 0% 97% / 0.5)';
      ctx.beginPath();
      for (let i = 0; i < n; i += 2) {
        const b = sk.blobs[i];
        if (b.dy > 0) continue; // 只盖树冠上半
        ctx.ellipse(px(sk.crown.cx + b.dx), py(sk.crown.cy + b.dy - b.r * 0.35), Math.max(0.5, b.r * 0.7 * sx), Math.max(0.4, b.r * 0.3 * sy), b.rot, 0, TAU);
      }
      ctx.fill();
    }

    // ——— 虫害暗斑 ———
    const pest = clamp(tree.pest ?? 0);
    if (pest > 0.03) {
      const count = Math.round(pest * sk.pestSpots.length);
      ctx.fillStyle = PEST_COLOR;
      ctx.globalAlpha = fade * Math.min(0.75, pest + 0.12);
      ctx.beginPath();
      for (let i = 0; i < count; i += 1) {
        const s = sk.pestSpots[i];
        const cxp = px(s.x); const cyp = py(s.y);
        const rr = s.r * su;
        for (let k = 0; k < 6; k += 1) {
          const a = s.rot + (k / 6) * TAU;
          const rrr = rr * s.poly[k];
          const vx = cxp + Math.cos(a) * rrr; const vy = cyp + Math.sin(a) * rrr;
          if (k === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
      }
      ctx.fill();
      ctx.globalAlpha = fade;
    }

    // ——— 芽 / 花苞（枝干分叉点 = 音符节点；扫描到就发亮开花）———
    const branches = tree.branches || [];
    const budR = Math.max(1.1, cw * 0.016 * su * zoomK);
    ctx.fillStyle = pal.bud;
    ctx.beginPath(); // 未激活的全部 batch 进一个路径
    for (const p of branches) {
      const d = wrapDist(stepFloat, p.step ?? 0, steps);
      if (Math.exp(-6 * d * d) >= 0.12) continue;
      const bx = px(p.x); const by = py(p.y) - budR * 0.7;
      ctx.moveTo(bx + budR, by);
      ctx.arc(bx, by, budR, 0, TAU);
    }
    ctx.fill();
    // 激活的：光晕 + 开花
    for (const p of branches) {
      const d = wrapDist(stepFloat, p.step ?? 0, steps);
      const act = Math.exp(-6 * d * d);
      if (act < 0.12) continue;
      const bx = px(p.x); const by = py(p.y) - budR * 0.7;
      const gr = budR * (2.2 + act * 2.2);
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, gr);
      g.addColorStop(0, `hsla(${tree.hue} 85% 78% / ${0.5 * act})`);
      g.addColorStop(1, `hsla(${tree.hue} 85% 78% / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(bx - gr, by - gr, gr * 2, gr * 2);
      if (act > 0.45) { // 开花：五瓣
        const pr = budR * (0.8 + act * 1.1);
        ctx.fillStyle = `hsl(${tree.hue} 60% 88% / ${0.9 * act})`;
        ctx.beginPath();
        for (let k = 0; k < 5; k += 1) {
          const a = (k / 5) * TAU - Math.PI / 2;
          ctx.ellipse(bx + Math.cos(a) * pr * 0.7, by + Math.sin(a) * pr * 0.7, pr * 0.55, pr * 0.32, a, 0, TAU);
        }
        ctx.fill();
        ctx.fillStyle = `hsl(48 95% 80% / ${act})`;
        ctx.beginPath(); ctx.arc(bx, by, pr * 0.3, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = `hsl(${tree.hue} 75% 80% / ${0.6 + act * 0.4})`;
        ctx.beginPath(); ctx.arc(bx, by, budR * (1 + act * 0.4), 0, TAU); ctx.fill();
      }
      // 夜间记入发光槽，纱罩之后再点一次
      if (night > 0.2 && this._glowCount < this._glowSlots.length) {
        const slot0 = this._glowSlots[this._glowCount];
        slot0.x = bx; slot0.y = by; slot0.r = gr; slot0.act = act; slot0.hue = tree.hue;
        this._glowCount += 1;
      }
    }

    // ——— 非焦点树：远景暗影（雾气推远）———
    if (!isFocus && u > 0.05 && fade < 1) {
      const hx = px(sk.crown.cx); const hy = py(sk.crown.cy);
      const hr = sk.crown.rx * 1.5 * sx;
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
      g.addColorStop(0, `hsla(210 35% 72% / ${u * 0.3})`);
      g.addColorStop(1, 'hsla(210 35% 72% / 0)');
      ctx.fillStyle = g;
      ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    }

    ctx.restore();
  }

  _trunkXAtY(pts, y) {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i]; const b = pts[i + 1];
      if (y <= a.y && y >= b.y) {
        const tt = (a.y - y) / Math.max(1e-6, a.y - b.y);
        return a.x + (b.x - a.x) * tt;
      }
    }
    return pts[pts.length - 1].x;
  }

  // ———————————————————————————— 草与花 ————————————————————————————
  _drawGrass(pal, season, meadowTop, backRowY, gustAt, t, px, py, sx, sy, su) {
    const ctx = this.ctx;
    const midY = (backRowY + meadowTop) / 2;
    // 三个色调各 batch 成一条路径
    for (let tone = 0; tone < 3; tone += 1) {
      ctx.strokeStyle = pal.grass[tone];
      ctx.lineWidth = Math.max(0.8, 0.0012 * su);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const g0 of this._grass) {
        if (g0.tone !== tone) continue;
        const y = meadowTop + 0.012 + g0.yFrac * (0.985 - meadowTop);
        const depth = clamp((y - meadowTop) / Math.max(0.05, 1 - meadowTop));
        const gh = g0.h * (0.5 + depth * 0.9);
        const gust = gustAt(g0.x);
        const sway = Math.sin(t * 1.3 + g0.phase + g0.x * 5) * (0.25 + 1.1 * gust) * gh * 0.5;
        const bx = px(g0.x); const by = py(y);
        const hh = gh * sy;
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx + sway * sx * 0.4, by - hh * 0.6, bx + sway * sx, by - hh);
        ctx.moveTo(bx + 1.5, by);
        ctx.quadraticCurveTo(bx + 1.5 + sway * sx * 0.3, by - hh * 0.45, bx + 1.5 + sway * sx * 0.8, by - hh * 0.75);
        ctx.moveTo(bx - 1.5, by);
        ctx.quadraticCurveTo(bx - 1.5 + sway * sx * 0.3, by - hh * 0.4, bx - 1.5 + sway * sx * 0.7, by - hh * 0.7);
      }
      ctx.stroke();
      // 后排丘上的矮草
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (const g0 of this._backGrass) {
        if (g0.tone !== tone) continue;
        const y = backRowY - 0.004 + g0.yFrac * Math.max(0.01, midY - backRowY);
        const gh = g0.h * 0.45;
        const sway = Math.sin(t * 1.2 + g0.phase) * 0.2 * gh;
        const bx = px(g0.x); const by = py(y);
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx + sway * sx * 0.5, by - gh * sy * 0.6, bx + sway * sx, by - gh * sy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 花（春/夏为四瓣小花，秋为穗，冬不画）
    if (season !== 3) {
      ctx.strokeStyle = pal.grass[1];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of this._flowers) {
        const y = meadowTop + 0.02 + f.yFrac * (0.96 - meadowTop);
        f._bx = px(f.x); f._by = py(y);
        const fh = f.h * sy;
        ctx.moveTo(f._bx, f._by);
        ctx.lineTo(f._bx, f._by - fh);
      }
      ctx.stroke();
      for (let tone = 0; tone < 3; tone += 1) {
        ctx.fillStyle = pal.flower[tone];
        ctx.beginPath();
        for (const f of this._flowers) {
          if (f.tone !== tone) continue;
          const fh = f.h * sy;
          const fx = f._bx; const fy = f._by - fh;
          if (season === 2) { // 秋：穗
            ctx.moveTo(fx + 1.6, fy);
            ctx.arc(fx, fy, 1.6, 0, TAU);
            ctx.moveTo(fx + 1.2, fy - 2.6);
            ctx.arc(fx, fy - 2.6, 1.2, 0, TAU);
          } else { // 春夏：四瓣小花
            for (let k = 0; k < 4; k += 1) {
              const a = (k / 4) * TAU + f.phase;
              const cxp = fx + Math.cos(a) * 2.2; const cyp = fy + Math.sin(a) * 2.2;
              ctx.moveTo(cxp + 1.4, cyp);
              ctx.arc(cxp, cyp, 1.4, 0, TAU);
            }
          }
        }
        ctx.fill();
      }
    }
  }

  // ———————————————————————————— 鸟 ————————————————————————————
  _flockStyle(flock) {
    let s = this._birdStyles.get(flock.id);
    if (!s || s.hue !== flock.hue) {
      const h0 = ((flock.hue % 360) + 360) % 360;
      // 按 flock 色相上色但保持写实感：压饱和度、亮度落在自然羽色区间
      s = {
        hue: flock.hue,
        body: `hsl(${h0} 42% 44%)`,
        belly: `hsl(${h0} 38% 74%)`,
        wing: `hsl(${h0} 40% 30%)`,
        dark: `hsl(${h0} 44% 20%)`,
        beak: 'hsl(32 70% 46%)',
        leg: 'hsl(25 45% 30%)',
      };
      this._birdStyles.set(flock.id, s);
    }
    return s;
  }

  _drawBirds(world, focusTree, u, t, dt, px, py) {
    const ctx = this.ctx;
    const flocks = world.flocks || [];
    const boids = world.boids || [];
    if (this._birdState.size > 256) this._birdState.clear();
    for (const boid of boids) {
      const flock = flocks[boid.flockId];
      const style = this._flockStyle(flock ?? { id: -1, hue: 200 });
      const homeTreeId = flock ? flock.homeTreeId : boid.flockId;
      const effTreeId = boid.perched ? boid.perched.treeId : homeTreeId;
      const fade = focusTree != null && effTreeId !== focusTree.id ? 1 - u * 0.55 : 1;
      if (fade < 0.05) continue;
      const x = px(boid.x); const y = py(boid.y);
      if (x < -60 || x > this.w + 60 || y < -60 || y > this.h + 60) continue;
      const depth = 0.62 + clamp(boid.y, 0, 1) * 0.55;
      let s = 0.0135 * this._su * depth;
      if (focusTree && effTreeId === focusTree.id) s *= 1 + u * 0.35;
      let st = this._birdState.get(boid.id);
      if (!st) { st = { angle: -Math.PI / 2, wing: hash01(boid.id * 9.17) * TAU }; this._birdState.set(boid.id, st); }
      const isGuest = boid.perched && homeTreeId !== boid.perched.treeId;
      ctx.save();
      ctx.globalAlpha = fade;
      if (boid.perched) {
        // 栖姿：收翅蹲姿，两脚扣枝（原点在落枝点），每隔几秒转头
        const headTurn = hash01(boid.id * 7.13 + Math.floor(t / 4 + hash01(boid.id * 3.71) * 7)) < 0.5 ? -1 : 1;
        const bob = Math.sin(t * 2.2 + boid.id * 1.3) * 0.02 * s;
        ctx.translate(x, y + bob);
        ctx.scale(headTurn, 1);
        this._birdPerched(ctx, s, style);
      } else {
        // 飞姿：朝向 = 屏幕空间速度方向（平滑转向），振翅频率随速度
        const svx = boid.vx * this.w; const svy = boid.vy * this.h;
        const sp = Math.hypot(svx, svy);
        if (sp > 1e-3) {
          const target = Math.atan2(svy, svx);
          let da = target - st.angle;
          while (da > Math.PI) da -= TAU;
          while (da < -Math.PI) da += TAU;
          st.angle += da * (1 - Math.exp(-dt * 8));
        }
        st.wing += dt * (6 + clamp(sp / Math.max(1, this.w * 0.05), 0, 1) * 11);
        ctx.translate(x, y);
        ctx.rotate(st.angle);
        this._birdFlying(ctx, s, style, st.wing);
      }
      ctx.restore();
      if (isGuest) { // 客鸟（串门出诊）：淡圈标记，沿用 app.js 的视觉语言
        ctx.strokeStyle = `hsla(45 80% 88% / ${0.45 * fade})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y - (boid.perched ? s * 0.6 : 0), s * 0.85, 0, TAU); ctx.stroke();
      }
    }
  }

  // 栖姿：原点在落枝点（脚底）
  _birdPerched(ctx, s, style) {
    // 腿（先画，压在身下）
    ctx.strokeStyle = style.leg;
    ctx.lineWidth = Math.max(0.7, s * 0.05);
    ctx.beginPath();
    ctx.moveTo(-s * 0.06, -s * 0.2); ctx.lineTo(-s * 0.05, 0);
    ctx.moveTo(s * 0.08, -s * 0.2); ctx.lineTo(s * 0.07, 0);
    ctx.stroke();
    // 尾：后下方两片
    ctx.fillStyle = style.wing;
    ctx.beginPath();
    ctx.moveTo(-s * 0.24, -s * 0.42);
    ctx.lineTo(-s * 0.78, -s * 0.1);
    ctx.lineTo(-s * 0.66, -s * 0.02);
    ctx.lineTo(-s * 0.16, -s * 0.3);
    ctx.closePath();
    ctx.fill();
    // 身体（蹲姿梨形）
    ctx.fillStyle = style.body;
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.52, s * 0.34, s * 0.42, 0.3, 0, TAU);
    ctx.fill();
    // 腹
    ctx.fillStyle = style.belly;
    ctx.beginPath();
    ctx.ellipse(s * 0.1, -s * 0.44, s * 0.2, s * 0.28, 0.3, 0, TAU);
    ctx.fill();
    // 收起的翅
    ctx.fillStyle = style.wing;
    ctx.beginPath();
    ctx.ellipse(-s * 0.06, -s * 0.54, s * 0.22, s * 0.3, 0.55, 0, TAU);
    ctx.fill();
    // 头 + 冠色 + 喙 + 眼
    ctx.fillStyle = style.body;
    ctx.beginPath(); ctx.arc(s * 0.16, -s * 0.94, s * 0.21, 0, TAU); ctx.fill();
    ctx.fillStyle = style.dark;
    ctx.beginPath(); ctx.arc(s * 0.16, -s * 0.98, s * 0.21, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
    ctx.fillStyle = style.beak;
    ctx.beginPath();
    ctx.moveTo(s * 0.34, -s * 0.97);
    ctx.lineTo(s * 0.52, -s * 0.92);
    ctx.lineTo(s * 0.34, -s * 0.88);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = style.dark;
    ctx.beginPath(); ctx.arc(s * 0.22, -s * 0.96, s * 0.035, 0, TAU); ctx.fill();
  }

  // 飞姿：原点在心，+x 为前进方向
  _birdFlying(ctx, s, style, wingPhase) {
    const flap = Math.sin(wingPhase);
    // 远翅（后、暗、反相）
    ctx.save();
    ctx.rotate(-0.25 - flap * 0.55);
    ctx.fillStyle = style.dark;
    this._wingPath(ctx, s * 0.85);
    ctx.fill();
    ctx.restore();
    // 尾扇
    ctx.fillStyle = style.wing;
    ctx.beginPath();
    ctx.moveTo(-s * 0.42, 0);
    ctx.lineTo(-s * 0.85, -s * 0.14);
    ctx.lineTo(-s * 0.8, 0);
    ctx.lineTo(-s * 0.85, s * 0.14);
    ctx.closePath();
    ctx.fill();
    // 身体（水滴形）
    ctx.fillStyle = style.body;
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.48, s * 0.24, 0, 0, TAU);
    ctx.fill();
    // 腹线
    ctx.fillStyle = style.belly;
    ctx.beginPath();
    ctx.ellipse(s * 0.05, s * 0.07, s * 0.34, s * 0.13, 0, 0, TAU);
    ctx.fill();
    // 头 + 喙 + 眼
    ctx.fillStyle = style.body;
    ctx.beginPath(); ctx.arc(s * 0.5, -s * 0.06, s * 0.17, 0, TAU); ctx.fill();
    ctx.fillStyle = style.beak;
    ctx.beginPath();
    ctx.moveTo(s * 0.64, -s * 0.1);
    ctx.lineTo(s * 0.82, -s * 0.05);
    ctx.lineTo(s * 0.64, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = style.dark;
    ctx.beginPath(); ctx.arc(s * 0.55, -s * 0.09, s * 0.03, 0, TAU); ctx.fill();
    // 近翅（主翅，大幅扇动）
    ctx.save();
    ctx.translate(s * 0.05, -s * 0.05);
    ctx.rotate(-0.15 + flap * 0.75);
    ctx.fillStyle = style.wing;
    this._wingPath(ctx, s);
    ctx.fill();
    ctx.restore();
  }

  _wingPath(ctx, s) {
    ctx.beginPath();
    ctx.moveTo(-s * 0.05, 0);
    ctx.quadraticCurveTo(s * 0.25, -s * 0.32, s * 0.05, -s * 0.95);
    ctx.quadraticCurveTo(-s * 0.28, -s * 0.5, -s * 0.38, -s * 0.12);
    ctx.closePath();
  }

  // ———————————————————————————— 粒子 ————————————————————————————
  _drawDrifters(pal, t, dt, px, py, su) {
    const ctx = this.ctx;
    const drift = pal.drift;
    for (const p of this._drifters) {
      p.y += p.vy * dt;
      p.x += (p.vx + Math.sin(t * p.flut + p.phase) * p.flutAmp) * dt;
      p.rot += p.rotV * dt;
      if (p.y > 1.03) { p.y = -0.03; p.x = hash01(p.seed + Math.floor(t)); }
      if (p.y < -0.05 && p.vy < 0) p.y = 1.02;
      if (p.x > 1.04) p.x = -0.04; else if (p.x < -0.04) p.x = 1.04;
      const x = px(p.x); const y = py(p.y);
      if (x < -20 || x > this.w + 20) continue;
      const size = p.size * su;
      ctx.fillStyle = drift.colors[p.tone];
      if (drift.kind === 'snow' || drift.kind === 'seed') {
        ctx.globalAlpha = drift.kind === 'snow' ? 0.85 : 0.5;
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, size), 0, TAU); ctx.fill();
      } else { // petal / leaf：旋转小椭圆
        ctx.globalAlpha = 0.75;
        ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.7, size), Math.max(0.5, size * 0.55), p.rot, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawGlowPass(night, daylight, t, px, py) {
    const ctx = this.ctx;
    ctx.save();
    // 星（夜）
    if (night > 0.15) {
      ctx.fillStyle = 'hsl(50 60% 90%)';
      for (const st of this._stars) {
        const tw = 0.3 + 0.7 * Math.max(0, Math.sin(t * st.tw + st.phase));
        ctx.globalAlpha = night * tw * 0.8;
        ctx.fillRect(px(st.x), py(st.y), st.r, st.r);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    // 夜间花苞余辉
    for (let i = 0; i < this._glowCount; i += 1) {
      const g0 = this._glowSlots[i];
      ctx.globalAlpha = night * g0.act * 0.5;
      const g = ctx.createRadialGradient(g0.x, g0.y, 0, g0.x, g0.y, g0.r);
      g.addColorStop(0, `hsla(${g0.hue} 85% 75% / 0.8)`);
      g.addColorStop(1, `hsla(${g0.hue} 85% 75% / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(g0.x - g0.r, g0.y - g0.r, g0.r * 2, g0.r * 2);
    }
    // 萤火虫（夜）
    if (night > 0.25) {
      for (const f of this._fireflies) {
        const fx = px(f.x + Math.sin(t * 0.24 + f.ph1) * 0.035);
        const fy = py(f.y + Math.cos(t * 0.31 + f.ph2) * 0.025);
        const glow = Math.max(0, Math.sin(t * 1.6 + f.ph2 * 3)) ** 2;
        ctx.globalAlpha = night * glow * 0.85;
        const r = 3.2 * (0.7 + glow * 0.5);
        const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, r);
        g.addColorStop(0, 'hsla(75 95% 72% / 0.9)');
        g.addColorStop(1, 'hsla(75 95% 72% / 0)');
        ctx.fillStyle = g;
        ctx.fillRect(fx - r, fy - r, r * 2, r * 2);
      }
    }
    // 昼间光尘 / 飘尘光斑
    if (daylight > 0.35) {
      ctx.fillStyle = 'hsl(48 95% 85%)';
      for (const m of this._motes) {
        const mx = px((((m.x + t * m.drift) % 1.1) + 1.1) % 1.1 - 0.05);
        const my = py(m.y + Math.sin(t * 0.4 + m.phase) * 0.012);
        ctx.globalAlpha = daylight * 0.16 * (0.4 + 0.6 * Math.max(0, Math.sin(t * 0.9 + m.phase * 2)));
        ctx.beginPath(); ctx.arc(mx, my, m.r, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ———————————————————————————— UI ————————————————————————————
  _drawLabels(trees, focusTree, u, px, py) {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = LABEL_FONT;
    for (const tree of trees) {
      const isFocus = focusTree != null && tree.id === focusTree.id;
      const fade = focusTree != null && !isFocus ? 1 - u * 0.7 : 1;
      if (fade < 0.05) continue;
      const x = px(tree.slot.x); const y = py(tree.slot.y) + 16;
      ctx.fillStyle = `hsl(28 45% 96% / ${0.5 * fade})`;
      ctx.fillText(`${tree.treeName} · ${tree.speciesName}`, x + 0.6, y + 0.6);
      ctx.fillStyle = `hsl(28 45% 24% / ${0.85 * fade})`;
      ctx.fillText(`${tree.treeName} · ${tree.speciesName}`, x, y);
    }
    // 贴近后：每条枝干行标注音名
    if (focusTree && u > 0.5) {
      const alpha = smoothstep(0.5, 0.8, u) * 0.9;
      const rows = this._limbRows(focusTree);
      ctx.font = NOTE_FONT;
      ctx.textAlign = 'right';
      for (const row of rows) {
        const x = px(row.x0) - 8; const y = py(row.y) + 3;
        ctx.fillStyle = `hsl(45 80% 95% / ${alpha * 0.6})`;
        ctx.fillText(midiName(row.midi), x + 0.5, y + 0.5);
        ctx.fillStyle = `hsl(28 45% 22% / ${alpha})`;
        ctx.fillText(midiName(row.midi), x, y);
      }
    }
    ctx.restore();
  }

  // ———————————————————————————— 静态景物生成 ————————————————————————————
  _ensureAssets(seed) {
    if (this._assetsSeed === seed) return;
    this._assetsSeed = seed;
    const rng = mulberry32((seed ^ 0x51f0a5) >>> 0);
    // 丘陵起伏包（相对后排树行/草地的位移）
    const bumps = (count, ampMax, wMin, wMax) => {
      const arr = [];
      for (let i = 0; i < count; i += 1) arr.push({ c: -0.1 + rng() * 1.2, a: rng() * ampMax, w: wMin + rng() * (wMax - wMin) });
      return arr;
    };
    this._bumpsFar = bumps(4, 0.13, 0.12, 0.3);
    this._bumpsMid = bumps(4, 0.05, 0.18, 0.4);
    this._bumpsMeadow = bumps(3, 0.03, 0.25, 0.5);
    // 云
    this._clouds = [];
    for (let i = 0; i < 5; i += 1) {
      const puffs = [];
      const n = 3 + ((rng() * 3) | 0);
      for (let k = 0; k < n; k += 1) puffs.push({ dx: (k - n / 2) * 0.35 + (rng() - 0.5) * 0.2, dy: (rng() - 0.5) * 0.3, r: 0.22 + rng() * 0.18 });
      this._clouds.push({ x: rng(), y: 0.05 + rng() * 0.24, s: 0.05 + rng() * 0.05, speed: 0.0016 + rng() * 0.002, puffs });
    }
    // 星
    this._stars = [];
    for (let i = 0; i < 110; i += 1) {
      this._stars.push({ x: rng(), y: rng() * 0.62, r: rng() < 0.85 ? 1 : 1.6, tw: 0.6 + rng() * 2.2, phase: rng() * TAU });
    }
    // 萤火虫
    this._fireflies = [];
    for (let i = 0; i < 34; i += 1) {
      this._fireflies.push({ x: rng(), y: 0.3 + rng() * 0.55, ph1: rng() * TAU, ph2: rng() * TAU });
    }
    // 昼间光尘
    this._motes = [];
    for (let i = 0; i < 20; i += 1) {
      this._motes.push({ x: rng(), y: 0.15 + rng() * 0.6, drift: 0.004 + rng() * 0.008, r: 1 + rng() * 1.8, phase: rng() * TAU });
    }
    // 草（yFrac 相对草地顶，布局变化时自适应）
    this._grass = [];
    for (let i = 0; i < 170; i += 1) {
      this._grass.push({ x: rng(), yFrac: rng(), h: 0.008 + rng() * 0.013, tone: (rng() * 3) | 0, phase: rng() * TAU });
    }
    this._backGrass = [];
    for (let i = 0; i < 56; i += 1) {
      this._backGrass.push({ x: rng(), yFrac: rng(), h: 0.007 + rng() * 0.009, tone: (rng() * 3) | 0, phase: rng() * TAU });
    }
    // 花
    this._flowers = [];
    for (let i = 0; i < 40; i += 1) {
      this._flowers.push({ x: rng(), yFrac: rng(), h: 0.008 + rng() * 0.01, tone: (rng() * 3) | 0, phase: rng() * TAU, _bx: 0, _by: 0 });
    }
    // 季节飘浮粒子池
    this._drifters = [];
    for (let i = 0; i < 46; i += 1) {
      this._drifters.push({
        x: rng(), y: rng(), vx: 0.004 + rng() * 0.01, vy: 0.012 + rng() * 0.016,
        flut: 1.5 + rng() * 2.5, flutAmp: 0.004 + rng() * 0.012, phase: rng() * TAU,
        rot: rng() * TAU, rotV: (rng() - 0.5) * 3, size: 0.0022 + rng() * 0.0028,
        tone: (rng() * 3) | 0, seed: rng() * 100,
      });
    }
  }

  _makePaper() {
    // 水彩纸纹：一次性生成的小噪声画布，平铺叠加
    const size = 140;
    const off = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!off) return { width: 1, height: 1 };
    off.width = size; off.height = size;
    const o = off.getContext('2d');
    const img = o.createImageData(size, size);
    const rng = mulberry32(0x9a7e11);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 215 + Math.floor(rng() * 40);
      img.data[i] = v; img.data[i + 1] = v - 4; img.data[i + 2] = v - 12;
      img.data[i + 3] = 26 + Math.floor(rng() * 22);
    }
    o.putImageData(img, 0, 0);
    return off;
  }
}
