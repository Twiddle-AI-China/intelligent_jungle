// 潜空间漫游器弹窗：选中/接管某个乐器后，打开一个可拖动的音色地图控制它。
//
// 视觉语言直接搬自 client/map.html（riso 双色印刷美学的既有实现，不是新发明）：
// 结构墨版方点（读作网点，不是发光粒子）+ 橙色印刷套准标记当光标 + 独立
// 慢漂移的错版效果 + 纸纤维颗粒 overlay。颜色不硬编码 map.html 的十六进制值，
// 改从宿主页面的 --paper/--ink/--accent 读，保证跟当前 mvp/ 的美学基准
// （单树 UI 那三个 token）完全一致，而不是自成一套。
//
// 产品表面只保留一张可拖动的“音色林地”。底层固定使用安全的邻近音色混合；
// kNN/PCA/高阶维等研究接口仍留在音频协议内部，不再要求用户理解。
//
// 数据来源：本乐器自己的 /assets/timbre/voice_maps/{species}.json
// （kNN 模式用 points[].x/y + scale；PCA 模式用 points[].px/py 做散点布局，
// pca_basis.ranges[i].p5/p95 做系数映射——两套坐标系不通用，混着用会导致
// "拖到哪儿"和"听到什么"对不上，这也是 map.html 已经踩过、写进注释的坑）。

const SPARSE_DIST = 0.18; // kNN 稀疏警示阈值；v2 语料比 v1 稀疏得多，阈值相应放宽

export function latentRoamerControlState({ configured, connected, focused } = {}) {
  if (!configured) {
    return { hidden: true, disabled: true, label: '', takesOver: false };
  }
  if (!connected) {
    return {
      hidden: false,
      disabled: true,
      label: '音色林地 · 连接中…',
      takesOver: false,
    };
  }
  return {
    hidden: false,
    disabled: false,
    label: focused ? '进入音色林地' : '进入音色林地（接管）',
    takesOver: !focused,
  };
}

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
 * @param {Function} [opts.onExplore] 成功下发音色位置后的只读观测回调。
 */
export function createLatentRoamer({
  audio,
  doc = typeof document !== 'undefined' ? document : null,
  onExplore = null,
} = {}) {
  if (!doc || !audio) {
    return { open() {}, close() {}, isOpen: () => false, destroy() {} };
  }

  let overlay = null;
  let canvas = null;
  let ctx = null;
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
  let panelSide = 'left';
  // open() 是异步的（decoder-status + 地图 JSON 两跳），而调用方（refreshMixControls）
  // 在黎明/切焦点/mute 时都会同步触发。没有 token 时，先发起的那次 await 返回后会把
  // 旧声部的 map 写进已经属于新声部的面板——"拖到哪儿"和"听到什么"就此对不上。
  let openToken = 0;
  let liveText = '';      // 仅在文案变化时写 DOM，避免 aria-live 被每帧刷屏
  let liveAt = 0;

  function palette() {
    return {
      paper: cssVar(doc, '--paper', '#F2EAD8'),
      ink: cssVar(doc, '--ink', '#2E3E8F'),
      accent: cssVar(doc, '--accent', '#E75C26'),
      pest: '#6B7A45',
    };
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
    // 地图不是粒子云：从语料点抽样成一团有方向的叶片，位置仍对应真实音色邻域。
    ctx.save();
    const stride = Math.max(1, Math.floor(points.length / 42));
    for (let i = 0; i < points.length; i += stride) {
      const [ax, ay] = pointXY(points[i]);
      const [cx, cy] = toCanvas(ax, ay);
      const angle = Math.atan2(ay, ax) + Math.PI / 4;
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(angle);
      ctx.globalAlpha = 0.2 + (i % 5) * 0.07;
      ctx.fillStyle = pal.ink;
      ctx.beginPath(); ctx.ellipse(0, 0, 7 * dpr, 3.2 * dpr, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.45; ctx.strokeStyle = pal.paper; ctx.lineWidth = 0.7 * dpr;
      ctx.beginPath(); ctx.moveTo(-5 * dpr, 0); ctx.lineTo(5 * dpr, 0); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // kNN 邻居：连线 + 高亮点。
    if (cursor.active && mode === 'knn' && neighbors.length) {
      const [ux, uy] = toCanvas(cursor.x, cursor.y);
      ctx.save();
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
    const voiceNames = { pad: '雾冠', melody: '鸣枝', bass: '深根', texture: '啄木' };
    label(voiceNames[species] ?? '音色林地', pad, pad + 15 * dpr, 13, 'left', 0.88);
    label(`${points.length} 种鸣色 · 拖动探索`, pad, pad + 32 * dpr, 10.5, 'left', 0.6);
    if (cursor.active) {
      const right = v.w - pad;
      const feeling = nearestDist < 0.06 ? '熟悉的鸣色' : nearestDist < 0.12 ? '正在蜕变' : '林地边缘';
      label(feeling, right, pad + 15 * dpr, 11, 'right', 0.8);
    }

    updateLiveReadout();
  }

  /**
   * 实时坐标读数。canvas 每帧重绘，但这一行是 aria-live 区域：60Hz 无条件写入
   * 会把屏幕阅读器彻底淹没，也每帧制造一次布局失效。这里降到 ~10Hz（与生态
   * 控制器的更新率一致）且只在文案真的变化时才碰 DOM。
   */
  function updateLiveReadout(force = false) {
    if (!uiRefs?.live || !map) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - liveAt < 100) return;
    liveAt = now;
    const s = map.scale || 1;
    const x = mode === 'knn' ? cursor.x * s : cursor.x;
    const y = mode === 'knn' ? cursor.y * s : cursor.y;
    const feeling = !cursor.active ? '等待探索'
      : nearestDist < 0.06 ? '熟悉的鸣色' : nearestDist < 0.12 ? '正在蜕变' : '林地边缘';
    const next = `${feeling} · X ${x.toFixed(3)} · Y ${y.toFixed(3)}`;
    if (next === liveText) return;
    liveText = next;
    uiRefs.live.textContent = next;
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
    let sent = false;
    let position = [cursor.x, cursor.y];
    if (mode === 'pca') {
      const ranges = map.pca_basis?.ranges || [];
      const span = (i, v) => {
        const r = ranges[i];
        if (!r) return v;
        return v < 0 ? -v * r.p5 : v * r.p95;
      };
      const coeffs = [span(0, cursor.x), span(1, cursor.y), ...hiDims];
      sent = audio.roamToPCA(species, coeffs);
      position = [cursor.x, cursor.y, ...hiDims.map((value, index) => {
        const range = ranges[index + 2];
        const edge = value < 0 ? Math.abs(Number(range?.p5) || 1) : Math.abs(Number(range?.p95) || 1);
        return Math.max(-1, Math.min(1, value / edge));
      })];
    } else {
      const s = map.scale || 1;
      position = [cursor.x * s, cursor.y * s];
      sent = audio.roamTo(species, position, k);
    }
    if (sent && typeof onExplore === 'function') {
      try { onExplore({ species, position, source: 'user', mode, sent: true }); } catch { /* 观测不得阻断音色 */ }
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
    ui.knnBtn?.classList.toggle('is-on', next === 'knn');
    ui.pcaBtn?.classList.toggle('is-on', next === 'pca');
    if (ui.dims) ui.dims.hidden = next !== 'pca';
    if (ui.kRow) ui.kRow.hidden = next === 'pca';
    if (next === 'pca' && ui.dimsBody && !ui.dimsBody.children.length) buildDimSliders(ui.dimsBody);
    if (ui.pcaBtn && !map.pca_basis) {
      ui.pcaBtn.disabled = true;
      ui.pcaBtn.title = '语料太薄，没能算出 PCA 基（见 tools/build_pca_basis_v2.py 的最小样本要求）';
    }
    cursor.active = false;
    draw();
  }

  function buildUI() {
    overlay = el(doc, 'div', 'roamer-overlay');
    const panel = el(doc, 'div', `roamer-panel is-${panelSide}`);
    panel.innerHTML = `
      <div class="roamer-head">
        <span class="roamer-title">音色林地</span>
        <button type="button" class="roamer-close" title="关闭（Esc）">✕</button>
      </div>
      <canvas class="roamer-canvas" tabindex="0" role="application" aria-label="音色林地，方向键移动潜空间坐标"></canvas>
      <div class="roamer-controls">
        <div class="roamer-row">
          <span class="roamer-live" aria-live="polite">等待探索 · X 0.000 · Y 0.000</span>
          <button type="button" class="roamer-btn roamer-hold">聆听当前鸣色</button>
        </div>
      </div>
      <div class="roamer-hint">拖动或方向键漫游 · 空格试听 · 坐标实时对应当前潜空间位置</div>
    `;
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);

    canvas = panel.querySelector('.roamer-canvas');
    ctx = canvas.getContext('2d');

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
      live: panel.querySelector('.roamer-live'),
    };

    ui.knnBtn?.addEventListener('click', () => setMode('knn', ui));
    ui.pcaBtn?.addEventListener('click', () => setMode('pca', ui));
    ui.dimsZero?.addEventListener('click', () => {
      hiDims = hiDims.map(() => 0);
      ui.dimsBody.querySelectorAll('input').forEach((i) => { i.value = 0; });
      if (cursor.active) sendTimbre();
    });
    ui.kSlider?.addEventListener('input', () => {
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

    canvas.addEventListener('pointerdown', (e) => {
      cursor.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      moveTo(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => { if (cursor.dragging) moveTo(e.clientX, e.clientY); });
    canvas.addEventListener('pointerup', () => { cursor.dragging = false; });
    canvas.addEventListener('pointercancel', () => { cursor.dragging = false; });
    canvas.addEventListener('keydown', (event) => {
      const delta = event.shiftKey ? 0.08 : 0.025;
      const moves = {
        ArrowLeft: [-delta, 0], ArrowRight: [delta, 0],
        ArrowUp: [0, delta], ArrowDown: [0, -delta],
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      cursor.x = Math.max(-1, Math.min(1, cursor.x + move[0]));
      cursor.y = Math.max(-1, Math.min(1, cursor.y + move[1]));
      cursor.active = true;
      const found = findNeighbors(cursor.x, cursor.y, k);
      neighbors = found.map((row) => row[1]);
      nearestDist = Math.sqrt(found[0]?.[0] ?? 0);
      // 键盘是离散步进：读数必须立刻跟上，不受 live 区域的 10Hz 节流影响。
      sendTimbre(); draw(); updateLiveReadout(true);
    });

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

  function showError(text) {
    if (!canvas) return;
    const pal = palette();
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    label(text, 14 * dpr, 24 * dpr, 12, 'left', 0.8);
  }

  // **前端物种名不等于后端 voice 名**（melody 前端叫 melody，后端行绑定的
  // 是 lead——见 docs/HANDOFF.md「物种↔后端行的映射不是全部对上的」）。
  // 之前直接拼 `/assets/timbre/voice_maps/${species}.json` 对 melody 会
  // 404（真实文件叫 lead.json）。改成：拿该物种的行号 → 查
  // /api/decoder-status 的 rowVoices[row] 找后端真名 → 用
  // voices[真名].roam.asset，全程不猜文件名。
  async function resolveAssetUrl(sp) {
    const row = audio.roamRow?.(sp);
    if (row == null) return null;
    const r = await fetch('/api/decoder-status');
    if (!r.ok) throw new Error(`decoder-status HTTP ${r.status}`);
    const status = await r.json();
    const model = status.models?.[0];
    const backendName = model?.rowVoices?.[row];
    const asset = backendName ? model.voices?.[backendName]?.roam?.asset : null;
    if (!asset) throw new Error(`行 ${row}（后端名 ${backendName ?? '?'}）没有漫游地图`);
    return asset;
  }

  async function open(nextSpecies, { assetUrl, side = 'left' } = {}) {
    if (overlay) close();
    const token = (openToken += 1);
    species = nextSpecies;
    panelSide = side === 'right' ? 'right' : 'left';
    uiRefs = buildUI();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    doc.addEventListener('keydown', onKeydown);

    let loaded = null;
    try {
      const url = assetUrl || await resolveAssetUrl(species);
      if (token !== openToken) return; // 期间已被 close/再次 open 取代
      if (!url) throw new Error(`${species} 没有绑定后端行`);
      const r = await fetch(url);
      if (token !== openToken) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      loaded = await r.json();
    } catch (error) {
      // 只有仍然是"当前这一次 open"才允许把错误画到面板上，否则会污染新声部。
      if (token !== openToken) return;
      showError(`地图加载失败: ${error?.message ?? error}`);
      return;
    }
    if (token !== openToken) return;
    map = loaded;
    k = 4;
    cursor = { x: 0, y: 0, active: false, dragging: false };
    liveText = ''; liveAt = 0;
    setMode('knn', uiRefs);
    updateLiveReadout(true);
    if (rafId) cancelAnimationFrame(rafId); // 兜住并发 open 遗留的循环，绝不叠两条 RAF
    rafId = requestAnimationFrame(loop);
  }

  /**
   * 面板已从模态遮罩改为常驻侧栏，keydown 仍挂 doc 只是为了在 canvas 未聚焦时也能
   * Esc 关闭。因此必须限定作用域：否则 Space 会吃掉页面上任何按钮的键盘激活，
   * Esc 也会和「先释放 USER、再回 overview」的两层返回语义抢焦点。
   */
  function withinRoamer(target) {
    return !!(overlay && target && typeof overlay.contains === 'function' && overlay.contains(target));
  }

  function onKeydown(e) {
    if (!overlay || !withinRoamer(e.target)) return;
    if (e.code === 'Escape') { e.preventDefault(); close(); }
    if (e.code === 'Space') { e.preventDefault(); if (uiRefs) toggleHold(uiRefs); }
  }

  function close() {
    openToken += 1; // 作废所有在途 open，避免其 await 返回后写进已关闭/新建的面板
    if (holding) { audio.previewRelease(); holding = false; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    liveText = ''; liveAt = 0;
    window.removeEventListener('resize', resizeCanvas);
    doc.removeEventListener('keydown', onKeydown);
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; canvas = null; ctx = null; map = null; species = null; uiRefs = null;
  }

  return {
    open,
    close,
    isOpen: () => !!overlay,
    currentSpecies: () => species,
    destroy: () => close(),
  };
}
