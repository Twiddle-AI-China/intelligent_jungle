// 年轮 ↔ audio 桥接：Canvas ring hit → audio.setParam；右侧只同步精确值。
// 不改 world USER/AGENT；浏览无关。

export const RING_PARAM_KEYS = Object.freeze([
  'eqLowDb',
  'eqMidDb',
  'eqHighDb',
  'reverbSend',
  'pingPongSend',
  'gain',
]);

export const RING_PARAM_SET = new Set(RING_PARAM_KEYS);

/** 默认范围（与 scene-layout.RING_RANGES 对齐；可被 getRingControls 覆盖）。 */
export const DEFAULT_RING_RANGES = Object.freeze({
  eqLowDb: Object.freeze([-12, 12]),
  eqMidDb: Object.freeze([-12, 12]),
  eqHighDb: Object.freeze([-12, 12]),
  reverbSend: Object.freeze([0, 1]),
  pingPongSend: Object.freeze([0, 1]),
  gain: Object.freeze([0, 2]),
});

export function isRingHit(hit) {
  return !!(hit && hit.type === 'ring' && RING_PARAM_SET.has(hit.ringId));
}

export function clampRingValue(controlId, value, ranges = DEFAULT_RING_RANGES) {
  const range = ranges[controlId] ?? DEFAULT_RING_RANGES[controlId];
  if (!range) return Number(value) || 0;
  const lo = range[0];
  const hi = range[1];
  const n = Number(value);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

/**
 * 指针纵向拖动调整年轮：上移增大。
 * @param {number} startValue
 * @param {number} deltaYPx  屏幕 Y 增量（向下为正）
 * @param {string} controlId
 * @param {number} [viewHeight=360]
 */
export function ringValueFromDrag(startValue, deltaYPx, controlId, viewHeight = 360, ranges = DEFAULT_RING_RANGES) {
  const range = ranges[controlId] ?? DEFAULT_RING_RANGES[controlId];
  if (!range) return startValue;
  const span = range[1] - range[0];
  const h = Math.max(1, Number(viewHeight) || 1);
  // 拖过约 0.45 视口高 = 满量程
  const next = Number(startValue) - ((Number(deltaYPx) || 0) / (h * 0.45)) * span;
  return clampRingValue(controlId, next, ranges);
}

/**
 * 把年轮值写入 renderer + audio（物种由 treeId→trees 解析）。
 * @returns {{ ok: boolean, value: number|null, species: string|null }}
 */
export function applyRingParam({
  renderer,
  audio,
  trees,
  treeId,
  controlId,
  value,
} = {}) {
  if (!RING_PARAM_SET.has(controlId) || treeId == null) {
    return { ok: false, value: null, species: null };
  }
  const tree = (trees ?? []).find((t) => t.id === treeId);
  if (!tree) return { ok: false, value: null, species: null };
  const species = tree.species;
  let next = clampRingValue(controlId, value);
  if (renderer && typeof renderer.setRingValue === 'function') {
    const written = renderer.setRingValue(treeId, controlId, next);
    if (written != null) next = written;
  }
  if (audio && typeof audio.setParam === 'function') {
    audio.setParam(species, controlId, next);
  }
  return { ok: true, value: next, species };
}

/**
 * 从 audio（或 renderer）读出当前声部年轮精确值，供右侧 readout。
 */
export function readRingValues({ renderer, audio, treeId, species } = {}) {
  const out = {};
  for (const key of RING_PARAM_KEYS) {
    let v = null;
    // 树干控件已移除，audio 运行时值（含 Agent 自动化）是唯一事实源；renderer
    // 只作为旧测试/旧调用方的兼容回退。
    if (audio && typeof audio.getMixParams === 'function' && species) {
      const params = audio.getMixParams(species) ?? {};
      v = params[key];
    }
    if (v == null && renderer && typeof renderer.getRingValue === 'function' && treeId != null) {
      v = renderer.getRingValue(treeId, key);
    }
    out[key] = Number.isFinite(Number(v)) ? Number(v) : (key === 'gain' ? 1 : 0);
  }
  return out;
}

/**
 * 启动时把 audio 当前混音参数同步进 renderer 年轮（避免两套初值漂移）。
 */
export function syncRingsFromAudio({ renderer, audio, trees } = {}) {
  if (!renderer || typeof renderer.setRingValue !== 'function') return 0;
  if (!audio || typeof audio.getMixParams !== 'function') return 0;
  let n = 0;
  for (const tree of trees ?? []) {
    const params = audio.getMixParams(tree.species) ?? {};
    for (const key of RING_PARAM_KEYS) {
      if (!Number.isFinite(Number(params[key]))) continue;
      renderer.setRingValue(tree.id, key, params[key]);
      n += 1;
    }
  }
  return n;
}

/**
 * 创建年轮拖动会话状态机（供 pointer 事件驱动；可单测）。
 */
export function createRingDragSession({
  renderer,
  audio,
  trees,
  viewHeight = () => 360,
  onChange = null,
} = {}) {
  let session = null; // { pointerId, treeId, controlId, startValue, lastY }

  function start(hit, event) {
    if (!isRingHit(hit)) return false;
    const treeId = hit.treeId;
    const controlId = hit.ringId;
    let startValue = 0;
    if (typeof renderer?.getRingValue === 'function') {
      const v = renderer.getRingValue(treeId, controlId);
      if (v != null) startValue = v;
    }
    session = {
      pointerId: event?.pointerId,
      treeId,
      controlId,
      startValue,
      originY: event?.clientY ?? 0,
    };
    return true;
  }

  function move(event) {
    if (!session) return null;
    if (event?.pointerId != null && session.pointerId != null
      && event.pointerId !== session.pointerId) return null;
    const dy = (event?.clientY ?? session.originY) - session.originY;
    const h = typeof viewHeight === 'function' ? viewHeight() : viewHeight;
    const next = ringValueFromDrag(session.startValue, dy, session.controlId, h);
    const result = applyRingParam({
      renderer,
      audio,
      trees,
      treeId: session.treeId,
      controlId: session.controlId,
      value: next,
    });
    if (result.ok && typeof onChange === 'function') {
      onChange(session.treeId, session.controlId, result.value);
    }
    return result;
  }

  function end(event) {
    if (!session) return false;
    if (event?.pointerId != null && session.pointerId != null
      && event.pointerId !== session.pointerId) return false;
    session = null;
    return true;
  }

  function isActive() { return !!session; }

  return { start, move, end, isActive };
}
