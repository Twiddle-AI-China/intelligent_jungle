// 绘本渲染器：暖阳田园风，纯 canvas 程序化绘制（无外部贴图）。
// 四棵写实风格的树（主干+枝干=音符行+叶团）、写实的鸟（栖/飞两态）、
// 昼夜天空与光，四季叶色，camera zoom 贴近。循环往复 = 日夜交替。

import { TAU } from '../world.js';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// 季节调色板：春新绿、夏浓绿、秋金橙、冬灰蓝。
const SEASONS = [
  { leaf: [111, 143, 82], sky: ['#cfe8d8', '#f0f2dc'], ground: '#bcd09a' },
  { leaf: [74, 122, 58], sky: ['#bfe0d2', '#eef0d0'], ground: '#a8c48c' },
  { leaf: [196, 138, 60], sky: ['#e8d8b0', '#f4e4bc'], ground: '#cbb07a' },
  { leaf: [140, 158, 168], sky: ['#c8d4dc', '#e8e4d4'], ground: '#c4c2ae' },
];
// 昼夜天光：dayPhase 0.25=正午 0.75=午夜。
function dayLight(dayPhase) {
  return clamp(0.5 + 0.5 * Math.cos((dayPhase - 0.25) * TAU));
}

export class StorybookRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.time = 0;
    this._treeCache = new Map(); // 树形随机骨架缓存（每棵树每帧一致）
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // 每棵树一棵稳定的随机骨架（主干弯曲 + 枝干角度），seeded。
  treeSkeleton(tree) {
    if (this._treeCache.has(tree.id)) return this._treeCache.get(tree.id);
    let s = tree.id * 7919 + 13;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const trunkBend = (rnd() - 0.5) * 0.3;
    const limbs = tree.branches.map((p) => ({
      angle: -Math.PI / 2 + (p.x - tree.slot.x) * 4 + (rnd() - 0.5) * 0.5,
      len: 0.5 + rnd() * 0.5,
      split: rnd() > 0.5,
    }));
    const skel = { trunkBend, limbs };
    this._treeCache.set(tree.id, skel);
    return skel;
  }

  draw(world, camera, focusFlockId, dt) {
    this.time += dt;
    const ctx = this.ctx;
    const w = this.canvas.clientWidth; const h = this.canvas.clientHeight;
    const day = dayLight(world.dayPhase);
    const season = SEASONS[world.season] ?? SEASONS[0];
    // ——— 天空 ———
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    const night = 1 - day;
    sky.addColorStop(0, this._mix(season.sky[0], '#1c2440', night * 0.85));
    sky.addColorStop(0.6, this._mix(season.sky[1], '#2a3350', night * 0.8));
    sky.addColorStop(1, this._mix(season.ground, '#1a2018', night * 0.7));
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    // 太阳 / 月亮
    const sunY = h * (0.75 - Math.sin(world.dayPhase * TAU) * 0.5);
    const sunX = w * (0.15 + world.dayPhase * 0.7);
    ctx.save();
    if (day > 0.4) { ctx.fillStyle = `rgba(230, 180, 90, ${0.5 * day})`; ctx.beginPath(); ctx.arc(sunX, sunY, 34, 0, TAU); ctx.fill(); }
    else { ctx.fillStyle = `rgba(230, 235, 245, ${0.5 * night})`; ctx.beginPath(); ctx.arc(w - sunX, sunY * 0.6, 22, 0, TAU); ctx.fill(); }
    ctx.restore();
    // 夜：萤火虫/星
    if (night > 0.4) {
      ctx.fillStyle = `rgba(255, 240, 180, ${0.5 * night})`;
      for (let i = 0; i < 24; i += 1) {
        const fx = ((i * 97.3) % 1) * w; const fy = ((i * 57.7) % 1) * h * 0.6;
        const tw = 0.5 + 0.5 * Math.sin(this.time * 2 + i);
        ctx.globalAlpha = tw * night * 0.7;
        ctx.beginPath(); ctx.arc(fx, fy, 1.4, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // ——— 地面 ———
    ctx.fillStyle = this._mix(season.ground, '#141a12', night * 0.7);
    ctx.beginPath(); ctx.moveTo(0, h * 0.86);
    ctx.quadraticCurveTo(w * 0.5, h * 0.8, w, h * 0.87);
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();

    ctx.save();
    ctx.translate(w / 2, h / 2); ctx.scale(camera.scale, camera.scale); ctx.translate(-camera.cx * w, -camera.cy * h);
    const toPx = (nx, ny) => [nx * w, ny * h];

    // ——— 四棵树 ———
    for (const tree of world.trees) {
      const fade = focusFlockId !== null && focusFlockId !== tree.id ? 1 - camera.u * 0.7 : 1;
      this._drawTree(ctx, world, tree, season, day, toPx, w, h, fade, focusFlockId, camera);
    }
    // ——— 鸟 ———
    for (const boid of world.boids) {
      const flock = world.flocks[boid.flockId];
      const fade = focusFlockId !== null && focusFlockId !== flock.homeTreeId ? 1 - camera.u * 0.5 : 1;
      this._drawBird(ctx, world, boid, flock, toPx, w, h, fade, camera);
    }
    ctx.restore();
  }

  _drawTree(ctx, world, tree, season, day, toPx, w, h, fade, focusFlockId, camera) {
    const [tx, ty] = toPx(tree.slot.x, tree.slot.y);
    const ch = world.config.canopyHeight * h;
    const cw = world.config.canopyWidth * w;
    const skel = this.treeSkeleton(tree);
    const night = 1 - day;
    const fol = tree.foliage;
    // 主干
    ctx.strokeStyle = this._rgba([107, 79, 53], fade * (0.9 - night * 0.3));
    ctx.lineCap = 'round';
    ctx.lineWidth = 7 * (0.7 + fol * 0.5);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(tx + skel.trunkBend * cw, ty - ch * 0.5, tx + skel.trunkBend * cw * 0.4, ty - ch * 0.85);
    ctx.stroke();
    // 枝干（音符行）：从主干顶部分叉到各 note 点。
    ctx.lineWidth = 3;
    tree.branches.forEach((p, i) => {
      const [px, py] = toPx(p.x, p.y);
      const chirp = tree.lastChirp && (world.time - tree.lastChirp) < 0.5 && p.branch === tree.lastChirpBranch;
      ctx.strokeStyle = this._rgba([107, 79, 53], fade * 0.75);
      ctx.beginPath(); ctx.moveTo(tx + skel.trunkBend * cw * 0.4, ty - ch * 0.85);
      ctx.quadraticCurveTo((tx + px) / 2, ty - ch * 0.9 + (py - ty) * 0.3, px, py);
      ctx.stroke();
      // 音符节点（芽/花苞），被「叫到」时发亮。
      const glow = chirp ? 1 : 0;
      ctx.fillStyle = glow ? `rgba(255, 220, 130, ${fade})` : this._rgba([140, 110, 70], fade * 0.5);
      ctx.beginPath(); ctx.arc(px, py, (3 + glow * 2.5) * (0.8 + camera.u * 0.6), 0, TAU); ctx.fill();
      // 贴近时显示音名
      if (focusFlockId === tree.id && camera.u > 0.5) {
        ctx.fillStyle = this._rgba([90, 80, 60], camera.u * 0.7);
        ctx.font = `${9 * camera.u}px 'DM Mono', monospace`; ctx.textAlign = 'center';
        ctx.fillText(String(p.midi), px, py - 8);
      }
    });
    // 叶团：foliage 决定茂密程度。
    const leaf = season.leaf;
    const blobs = Math.round(3 + fol * 6);
    for (let i = 0; i < blobs; i += 1) {
      const ang = (i / blobs) * TAU;
      const bx = tx + Math.cos(ang) * cw * 0.35 + skel.trunkBend * cw * 0.3;
      const by = ty - ch * 0.7 + Math.sin(ang) * ch * 0.2;
      const r = cw * (0.12 + fol * 0.1);
      ctx.fillStyle = this._rgba(leaf, fade * (0.35 + fol * 0.4) * (1 - night * 0.4));
      ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill();
    }
    // 虫害斑
    if (tree.pest > 0.03) {
      ctx.fillStyle = `rgba(120, 70, 40, ${Math.min(0.6, tree.pest) * fade})`;
      for (let i = 0; i < tree.pest * 8; i += 1) {
        const bx = tx + Math.sin(i * 2.3 + tree.id) * cw * 0.3;
        const by = ty - ch * (0.3 + Math.abs(Math.sin(i * 1.7)) * 0.5);
        ctx.beginPath(); ctx.arc(bx, by, 2.2, 0, TAU); ctx.fill();
      }
    }
    // 树名
    ctx.fillStyle = this._rgba([90, 80, 60], fade * 0.85);
    ctx.font = `500 12px 'Noto Sans SC', sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(`${tree.treeName}·${tree.speciesName}`, tx, ty + 18);
  }

  _drawBird(ctx, world, boid, flock, toPx, w, h, fade, camera) {
    const [x, y] = toPx(boid.x, boid.y);
    const size = (boid.perched ? 5 : 6) * (0.8 + camera.u * 0.6);
    const hue = flock.hue;
    ctx.save(); ctx.translate(x, y);
    if (boid.perched) {
      // 收翅蹲姿：圆身 + 头 + 尾
      ctx.fillStyle = this._rgba(this._hsl2rgb(hue, 0.45, 0.4), fade * 0.95);
      ctx.beginPath(); ctx.ellipse(0, 0, size * 0.8, size * 0.6, 0, 0, TAU); ctx.fill(); // 身
      ctx.beginPath(); ctx.arc(size * 0.6, -size * 0.5, size * 0.35, 0, TAU); ctx.fill(); // 头
      ctx.beginPath(); ctx.moveTo(-size * 0.7, 0); ctx.lineTo(-size * 1.3, -size * 0.2); ctx.lineTo(-size * 0.7, size * 0.25); ctx.closePath(); ctx.fill(); // 尾
    } else {
      // 展翅飞姿：身体 + 两片展开的翅
      ctx.rotate(Math.atan2(boid.vy, boid.vx));
      ctx.fillStyle = this._rgba(this._hsl2rgb(hue, 0.5, 0.45), fade * 0.9);
      ctx.beginPath(); ctx.ellipse(0, 0, size, size * 0.4, 0, 0, TAU); ctx.fill(); // 身
      const flap = Math.sin(this.time * 12 + boid.id) * 0.5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(size * 0.5, -size * (1 + flap), size * 1.2, -size * 0.4); ctx.quadraticCurveTo(size * 0.5, -size * 0.2, 0, 0); ctx.fill(); // 上翅
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(size * 0.5, size * (1 - flap), size * 1.2, size * 0.4); ctx.quadraticCurveTo(size * 0.5, size * 0.2, 0, 0); ctx.fill(); // 下翅
    }
    ctx.restore();
  }

  // ——— 工具 ———
  _mix(hexA, hexB, t) {
    const a = this._hex2rgb(hexA); const b = this._hex2rgb(hexB);
    return this._rgba([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], 1);
  }
  _hex2rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  _rgba([r, g, b], a) { return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${clamp(a)})`; }
  _hsl2rgb(h, s, l) {
    s = clamp(s); l = clamp(l);
    const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
    let rgb = [0, 0, 0];
    if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0]; else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c]; else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
    return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
  }
}
