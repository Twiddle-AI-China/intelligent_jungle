// 潜空间漫游器弹窗：选中/接管某个乐器后，打开一个可拖动的音色地图控制它。
//
// 视觉语言直接搬自 client/map.html（riso 双色印刷美学的既有实现，不是新发明）：
// 结构墨版方点（读作网点，不是发光粒子）+ 橙色印刷套准标记当光标 + 独立
// 慢漂移的错版效果 + 纸纤维颗粒 overlay。颜色不硬编码 map.html 的十六进制值，
// 改从宿主页面的 --paper/--ink/--accent 读，保证跟当前 mvp/ 的美学基准
// （单树 UI 那三个 token）完全一致，而不是自成一套。
//
// 两种漫游模式（跟 map.html 同一套取舍，见 docs/latent-map.md）：
//   kNN —— XY → 最近 k 个真实 preset 加权混合。安全，永远在凸包内。
//   PCA —— XY 映射到该乐器自己的 PC1/PC2，高阶维（PC3+）由滑杆给，
//          z = mean + Σ coeff·basis。**不保证落在训练流形上**——这条腿
//          存在的意义就是听"万一走出流形会怎样"，极端系数可能出怪音、
//          失真、甚至不发声，这是协议本身的性质，不是这个弹窗的 bug。
//          v2 每个乐器的 PCA 基是从它自己的漫游地图语料算的（~30–50 个
//          preset），比 v1 算基用的 1239 个薄得多，「解释方差」这类数字
//          虚高，别当成稳健统计量（tools/build_pca_basis_v2.py 有完整论证）。
//
// 数据来源：本乐器自己的 /assets/timbre/voice_maps/{species}.json
// （kNN 模式用 points[].x/y + scale；PCA 模式用 points[].px/py 做散点布局，
// pca_basis.ranges[i].p5/p95 做系数映射——两套坐标系不通用，混着用会导致
// "拖到哪儿"和"听到什么"对不上，这也是 map.html 已经踩过、写进注释的坑）。

const DOT_ALPHA_A = 0.38;
const DOT_ALPHA_B = 0.58;
const SPARSE_DIST = 0.18; // kNN 稀疏警示阈值；v2 语料比 v1 稀疏得多，阈值相应放宽

function el(doc, tag, className, html) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function cssVar(doc, name, fallback) {
  const v = getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * @param {object} opts
 * @param {object} opts.audio 来自 createAudioEngine() 的返回值——用它的
 *   roamTo / roamToPCA / previewHold / previewRelease / isNeural。
 * @param {Document} [opts.doc]
 */
export function createLatentRoamer({ audio, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (!doc || !audio) {
    return { open() {}, close() {}, isOpen: () => false, destroy() {} };
  }

  let overlay = null;
  let canvas = null;
  let ctx = null;
  let grain = null;
  let dpr = 1;
  let rafId = null;

  let species = null;
  let map = null;        // 加载到的 voice_maps/{species}.json
  let mode = 'knn';       // 'knn' | 'pca'
  let k = 4;
  let cursor = { x: 0, y: 0, active: false, dragging: false };
  let neighbors = [];
  let nearestDist = 0;
  let hiDims = [];        // PC3.. 的系数
  let holding = false;

  function palette() {
    return {
      paper: cssVar(doc, '--paper', '#F2EAD8'),
      ink: cssVar(doc, '--ink', '#2E3E8F'),
      accent: cssVar(doc, '--accent', '#E75C26'),
      pest: '#6B7A45',
    };
  }

  function makeGrain() {
    const N = 256;
    const c = doc.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i += 1) {
      const y = (i / N) | 0;
      const fiber = Math.sin(y * 0.7) * 6;
      const v = 128 + (Math.random() - 0.5) * 26 + fiber;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 16;
    }
    g.putImageData(img, 0, 0);
    grain = ctx.createPattern(c, 'repeat');
  }

  function view() {
    const w = canvas.width, h = canvas.height;
    return { w, h, cx: w / 2, cy: h / 2, scale: Math.min(w, h) * 0.46 };
  }
  const toCanvas = (x, y) => { const v = view(); return [v.cx + x * v.scale, v.cy - y * v.scale]; };
  const toMapXY = (px, py) => { const v = view(); return [(px - v.cx) / v.scale, (v.cy - py) / v.scale]; };

  // kNN 模式：地图坐标是 points[].x/y，范围 [-scale,+scale]（跟 client/tracks.html
  // 同一约定，发给服务端的 timbreXY 就是这套原始坐标，不额外归一化）。
  // PCA 模式：地图坐标是 points[].px/py（PC1/PC2 投影，已归一化到约 [-1,1]，
  // 纯粹用于散点摆放；真正发给服务端的系数走 pca.ranges 的 p5/p95 映射）。
  function pointXY(p) {
    if (mode === 'pca') return [p.px ?? 0, p.py ?? 0];
    const s = map.scale || 1;
    return [p.x / s, p.y / s];
  }

  function label(text, x, y, size, align, alpha, colorOverride) {
    const pal = palette();
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 0.72 : alpha;
    ctx.fillStyle = colorOverride || pal.ink;
    ctx.font = `${size * dpr}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = align || 'left';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function draw() {
    if (!canvas || !map) return;
    const pal = palette();
    const v = view();
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, v.w, v.h);

    const points = map.points;
    const t = performance.now() * 0.0001;
    const misS = [Math.sin(t * 6.28) * 1.4 * dpr, Math.cos(t * 5.1) * 1.1 * dpr];
    const misA = [-Math.sin(t * 5.6) * 1.3 * dpr, Math.cos(t * 6.9) * 1.2 * dpr];

    // 结构墨版：散点，方点读作网点。
    ctx.save();
    ctx.translate(misS[0], misS[1]);
    const size = 2.6 * dpr;
    for (let i = 0; i < points.length; i += 1) {
      const [ax, ay] = pointXY(points[i]);
      const [cx, cy] = toCanvas(ax, ay);
      ctx.globalAlpha = i % 3 === 0 ? DOT_ALPHA_A : DOT_ALPHA_B;
      ctx.fillStyle = pal.ink;
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    }
    ctx.restore();

    // kNN 邻居：连线 + 高亮点。
    if (cursor.active && mode === 'knn' && neighbors.length) {
      const [ux, uy] = toCanvas(cursor.x, cursor.y);
      ctx.save();
      ctx.translate(misS[0], misS[1]);
      ctx.strokeStyle = pal.ink;
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = dpr;
      for (const i of neighbors) {
        const [ax, ay] = pointXY(points[i]);
        const [nx, ny] = toCanvas(ax, ay);
        ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(nx, ny); ctx.stroke();
      }
      ctx.globalAlpha = 0.9;
      for (const i of neighbors) {
        const [ax, ay] = pointXY(points[i]);
        const [nx, ny] = toCanvas(ax, ay);
        ctx.fillStyle = pal.ink;
        ctx.fillRect(nx - 2.4 * dpr, ny - 2.4 * dpr, 4.8 * dpr, 4.8 * dpr);
      }
      ctx.restore();
    }

    // accent 墨版：印刷套准标记当光标，两种模式都画。
    if (cursor.active) {
      const [ux, uy] = toCanvas(cursor.x, cursor.y);
      ctx.save();
      ctx.translate(misA[0], misA[1]);
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1.6 * dpr;
      const r = 13 * dpr;
      ctx.strokeRect(ux - r, uy - r, r * 2, r * 2);
      ctx.beginPath();
      ctx.moveTo(ux - r * 1.55, uy); ctx.lineTo(ux - r * 0.45, uy);
      ctx.moveTo(ux + r * 0.45, uy); ctx.lineTo(ux + r * 1.55, uy);
      ctx.moveTo(ux, uy - r * 1.55); ctx.lineTo(ux, uy - r * 0.45);
      ctx.moveTo(ux, uy + r * 0.45); ctx.lineTo(ux, uy + r * 1.55);
      ctx.stroke();
      ctx.restore();
    }

    // 稀疏警示：虫斑绿虚线圈，只在 kNN 模式（PCA 模式没有"稀疏"这个概念）。
    if (cursor.active && mode === 'knn' && nearestDist > SPARSE_DIST) {
      const [ux, uy] = toCanvas(cursor.x, cursor.y);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = pal.pest;
      ctx.lineWidth = dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.arc(ux, uy, 30 * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      label('此处稀薄 · 音色会黏住', ux + 36 * dpr, uy + 4 * dpr, 11, 'left', 0.62);
    }

    // 标注。
    const pad = 14 * dpr;
    label(map.voice ?? species, pad, pad + 15 * dpr, 13, 'left', 0.88);
    label(mode === 'pca'
      ? `${points.length} 种声音 · PC1/PC2 投影 · 无约束`
      : `${points.length} 种声音 · ${map.layout ?? '?'} 布局 · kNN 约束`,
    pad, pad + 32 * dpr, 10.5, 'left', 0.6);
    if (cursor.active) {
      const right = v.w - pad;
      label(`${cursor.x.toFixed(3)}, ${cursor.y.toFixed(3)}`, right, pad + 15 * dpr, 11, 'right', 0.8);
      if (mode === 'knn' && neighbors.length) {
        label(points[neighbors[0]].id ?? '', right, pad + 30 * dpr, 10, 'right', 0.55);
        label(`最近 ${nearestDist.toFixed(3)}`, right, pad + 44 * dpr, 10, 'right', 0.55);
      }
    }

    if (grain) {
      ctx.save();
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, v.w, v.h);
      ctx.restore();
    }
  }

  function loop() {
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function findNeighbors(x, y, kk) {
    const d = map.points.map((p, i) => {
      const [ax, ay] = pointXY(p);
      return [(ax - x) ** 2 + (ay - y) ** 2, i];
    });
    d.sort((a, b) => a[0] - b[0]);
    return d.slice(0, kk);
  }

  // 高阶主成分（PC3+）系数 → 实际值域：屏幕滑杆本身就用 p5–p95 当 min/max，
  // 不需要像 PC1/PC2 那样做符号相关的映射（那是因为 PC1/PC2 兼职当散点布局，
  // 高阶维没有这层双重身份）。
  function sendTimbre() {
    if (!species) return;
    if (mode === 'pca') {
      const ranges = map.pca_basis?.ranges || [];
      const span = (i, v) => {
        const r = ranges[i];
        if (!r) return v;
        return v < 0 ? -v * r.p5 : v * r.p95;
      };
      const coeffs = [span(0, cursor.x), span(1, cursor.y), ...hiDims];
      audio.roamToPCA(species, coeffs);
    } else {
      const s = map.scale || 1;
      audio.roamTo(species, [cursor.x * s, cursor.y * s], k);
    }
  }

  function moveTo(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const [x, y] = toMapXY(px, py);
    cursor.x = x; cursor.y = y; cursor.active = true;
    if (mode === 'knn') {
      const found = findNeighbors(x, y, k);
      neighbors = found.map((f) => f[1]);
      nearestDist = Math.sqrt(found[0]?.[0] ?? 0);
    }
    sendTimbre();
  }

  function buildDimSliders(host) {
    const ranges = map.pca_basis?.ranges || [];
    const n = map.pca_basis?.dims || 0;
    hiDims = new Array(Math.max(0, n - 2)).fill(0);
    host.innerHTML = '';
    if (n <= 2) return;
    for (let i = 2; i < n; i += 1) {
      const r = ranges[i] || { p5: -2, p95: 2 };
      const pct = ((map.pca_basis.explained?.[i] || 0) * 100).toFixed(1);
      const row = el(doc, 'div', 'roamer-dim',
        `<span>PC${i + 1}</span>`
        + `<input type="range" min="${r.p5.toFixed(3)}" max="${r.p95.toFixed(3)}" step="0.01" value="0">`
        + `<span class="roamer-dim-pct">${pct}%</span>`);
      const input = row.querySelector('input');
      input.addEventListener('input', () => {
        hiDims[i - 2] = Number(input.value);
        if (cursor.active) sendTimbre();
      });
      host.appendChild(row);
    }
  }

  function setMode(next, ui) {
    mode = next;
    ui.knnBtn.classList.toggle('is-on', next === 'knn');
    ui.pcaBtn.classList.toggle('is-on', next === 'pca');
    ui.dims.hidden = next !== 'pca';
    ui.kRow.hidden = next === 'pca';
    if (next === 'pca' && !ui.dimsBody.children.length) buildDimSliders(ui.dimsBody);
    if (!map.pca_basis) {
      ui.pcaBtn.disabled = true;
      ui.pcaBtn.title = '语料太薄，没能算出 PCA 基（见 tools/build_pca_basis_v2.py 的最小样本要求）';
    }
    cursor.active = false;
    draw();
  }

  function buildUI() {
    overlay = el(doc, 'div', 'roamer-overlay');
    const panel = el(doc, 'div', 'roamer-panel');
    panel.innerHTML = `
      <div class="roamer-head">
        <span class="roamer-title">潜空间漫游器</span>
        <button type="button" class="roamer-close" title="关闭（Esc）">✕</button>
      </div>
      <canvas class="roamer-canvas"></canvas>
      <div class="roamer-controls">
        <div class="roamer-row">
          <button type="button" class="roamer-btn roamer-mode is-on" data-mode="knn">kNN 约束</button>
          <button type="button" class="roamer-btn roamer-mode" data-mode="pca">PCA 自由</button>
          <button type="button" class="roamer-btn roamer-hold">按住试听</button>
        </div>
        <div class="roamer-row roamer-k-row">
          <label>邻居 k
            <input type="range" class="roamer-k" min="1" max="16" step="1" value="4">
            <span class="roamer-k-v">4</span>
          </label>
        </div>
        <div class="roamer-dims" hidden>
          <div class="roamer-dims-title">高阶主成分</div>
          <div class="roamer-dims-body"></div>
          <button type="button" class="roamer-btn roamer-dims-zero">全部归零</button>
        </div>
      </div>
      <div class="roamer-hint">拖动画布即漫游 · 空格/按钮按住试听 · Esc 关闭</div>
    `;
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);

    canvas = panel.querySelector('.roamer-canvas');
    ctx = canvas.getContext('2d');
    makeGrain();

    const ui = {
      knnBtn: panel.querySelector('[data-mode="knn"]'),
      pcaBtn: panel.querySelector('[data-mode="pca"]'),
      kRow: panel.querySelector('.roamer-k-row'),
      kSlider: panel.querySelector('.roamer-k'),
      kValue: panel.querySelector('.roamer-k-v'),
      dims: panel.querySelector('.roamer-dims'),
      dimsBody: panel.querySelector('.roamer-dims-body'),
      dimsZero: panel.querySelector('.roamer-dims-zero'),
      holdBtn: panel.querySelector('.roamer-hold'),
      closeBtn: panel.querySelector('.roamer-close'),
    };

    ui.knnBtn.addEventListener('click', () => setMode('knn', ui));
    ui.pcaBtn.addEventListener('click', () => setMode('pca', ui));
    ui.dimsZero.addEventListener('click', () => {
      hiDims = hiDims.map(() => 0);
      ui.dimsBody.querySelectorAll('input').forEach((i) => { i.value = 0; });
      if (cursor.active) sendTimbre();
    });
    ui.kSlider.addEventListener('input', () => {
      k = Number(ui.kSlider.value);
      ui.kValue.textContent = String(k);
      if (cursor.active) {
        const found = findNeighbors(cursor.x, cursor.y, k);
        neighbors = found.map((f) => f[1]);
        nearestDist = Math.sqrt(found[0]?.[0] ?? 0);
        sendTimbre();
      }
    });
    ui.holdBtn.addEventListener('click', () => toggleHold(ui));
    ui.closeBtn.addEventListener('click', () => close());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    canvas.addEventListener('pointerdown', (e) => {
      cursor.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      moveTo(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => { if (cursor.dragging) moveTo(e.clientX, e.clientY); });
    canvas.addEventListener('pointerup', () => { cursor.dragging = false; });
    canvas.addEventListener('pointercancel', () => { cursor.dragging = false; });

    return ui;
  }

  let uiRefs = null;

  function toggleHold(ui) {
    holding = !holding;
    ui.holdBtn.classList.toggle('is-on', holding);
    if (holding) {
      const ok = audio.previewHold(species, 60, 0.8);
      if (!ok) {
        holding = false;
        ui.holdBtn.classList.remove('is-on');
        ui.holdBtn.title = '没有空闲行可以试听（真实和弦占满了）';
      }
    } else {
      audio.previewRelease();
    }
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 360, cssH = canvas.clientHeight || 300;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  async function open(nextSpecies, { assetUrl } = {}) {
    if (overlay) close();
    species = nextSpecies;
    uiRefs = buildUI();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    doc.addEventListener('keydown', onKeydown);

    const url = assetUrl || `/assets/timbre/voice_maps/${species}.json`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      map = await r.json();
    } catch (error) {
      if (canvas) {
        const pal = palette();
        ctx.fillStyle = pal.paper;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        label(`地图加载失败: ${error?.message ?? error}`, 14 * dpr, 24 * dpr, 12, 'left', 0.8);
      }
      return;
    }
    k = 4;
    cursor = { x: 0, y: 0, active: false, dragging: false };
    setMode('knn', uiRefs);
    rafId = requestAnimationFrame(loop);
  }

  function onKeydown(e) {
    if (e.code === 'Escape') { e.preventDefault(); close(); }
    if (e.code === 'Space' && overlay) { e.preventDefault(); if (uiRefs) toggleHold(uiRefs); }
  }

  function close() {
    if (holding) { audio.previewRelease(); holding = false; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    window.removeEventListener('resize', resizeCanvas);
    doc.removeEventListener('keydown', onKeydown);
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; canvas = null; ctx = null; map = null; species = null; uiRefs = null;
  }

  return {
    open,
    close,
    isOpen: () => !!overlay,
    destroy: () => close(),
  };
}
