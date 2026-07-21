// 视口输入：滚轮 / 触控拖动 → moveViewportBy（只浏览，不切 USER / 不改混音）。

export const PAN_THRESHOLD_PX = 8;

export const VOICE_ORDER_DEFAULT = Object.freeze(['pad', 'melody', 'bass', 'texture']);

/** 滚轮 deltaY（CSS px）→ 声部带单位（1 ≈ 下移一带）。桌面自然滚轮：下滚看下方。 */
export function wheelDeltaToBands(deltaY, viewHeight) {
  const h = Math.max(1, Number(viewHeight) || 1);
  return (Number(deltaY) || 0) / h;
}

/**
 * 触控/指针纵向拖动 → 声部带单位。
 * 自然滚动：手指上滑（dy<0）看下方声部 → 视口下移（正 delta）。
 * 与桌面 wheel 符号约定一致（内容随手势方向移动）。
 */
export function panPixelsToBands(deltaYPx, viewHeight) {
  const h = Math.max(1, Number(viewHeight) || 1);
  return -(Number(deltaYPx) || 0) / h;
}

/**
 * 安全调用 moveViewportBy。
 * @returns {{ ok: boolean, delta: number }}
 */
export function applyViewportDelta(renderer, deltaBands) {
  const delta = Number(deltaBands) || 0;
  if (!renderer || typeof renderer.moveViewportBy !== 'function' || delta === 0) {
    return { ok: false, delta };
  }
  renderer.moveViewportBy(delta);
  return { ok: true, delta };
}

/** 相邻声部 id（delta<0 向上）。 */
export function adjacentVoiceId(currentId, delta, voices = VOICE_ORDER_DEFAULT) {
  const list = Array.isArray(voices) && voices.length ? voices : VOICE_ORDER_DEFAULT;
  const idx = list.indexOf(currentId);
  const from = idx >= 0 ? idx : 0;
  const next = Math.max(0, Math.min(list.length - 1, from + Number(delta || 0)));
  return list[next];
}

/**
 * 键盘上下：按当前可见声部吸附到相邻声部中心（非 moveViewportBy 相对步进）。
 * 从非吸附位置一次按键即可落到相邻带。
 * @returns {{ ok: boolean, voiceId: string|null, method: string|null }}
 */
export function snapKeyboardBrowse(renderer, delta, voices = VOICE_ORDER_DEFAULT) {
  const list = Array.isArray(voices) && voices.length ? voices : VOICE_ORDER_DEFAULT;
  let cur = list[0];
  if (typeof renderer?.getVisibleVoice === 'function') {
    const v = renderer.getVisibleVoice();
    if (v != null && v !== '') cur = v;
  }
  const next = adjacentVoiceId(cur, delta, list);
  if (typeof renderer?.focusVoice === 'function') {
    renderer.focusVoice(next);
    return { ok: true, voiceId: next, method: 'focusVoice' };
  }
  const moved = applyViewportDelta(renderer, delta);
  return { ok: moved.ok, voiceId: next, method: moved.ok ? 'moveViewportBy' : null };
}

/**
 * Canvas 短点语义（纯函数，便于单测）。
 * AGENT 点 branch/bird/sequence-node → 仅 takeoverOnly（同次点击不摆/赶鸟）。
 */
export function resolveCanvasTapAction(hit, isUserForTree) {
  if (!hit) return { action: 'none' };
  if (hit.type === 'tree') {
    return { action: 'browseVoice', treeId: hit.treeId };
  }
  if (hit.type === 'branch' || hit.type === 'bird' || hit.type === 'sequence-node') {
    if (!isUserForTree) {
      return { action: 'takeoverOnly', treeId: hit.treeId };
    }
    if (hit.type === 'bird') {
      return { action: 'shoo', treeId: hit.treeId, birdId: hit.birdId };
    }
    if (hit.type === 'sequence-node') {
      return {
        action: 'toggleSequenceCell',
        treeId: hit.treeId,
        pitchBranchId: hit.pitchBranchId,
        stepIndex: hit.stepIndex,
      };
    }
    return { action: 'place', treeId: hit.treeId, branchId: hit.branchId };
  }
  return { action: 'none' };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.canvas
 * @param {object} opts.renderer
 * @param {(event: PointerEvent|WheelEvent) => { x: number, y: number }} opts.canvasPoint
 * @param {() => boolean} [opts.isBlocked]
 * @param {(hit: object|null, event: PointerEvent) => 'ring'|'consume'|null} [opts.onPointerDownHit]
 * @param {(event: PointerEvent) => void} [opts.onSuppressedMove]
 * @param {(event: PointerEvent) => void} [opts.onSuppressedUp]
 * @param {(hit: object|null, event: PointerEvent) => void} [opts.onTap]
 * @param {(event: PointerEvent, hit: object|null) => void} [opts.onHover]
 * @param {() => void} [opts.onViewportChange]
 */
export function attachViewportInput({
  canvas,
  renderer,
  canvasPoint,
  isBlocked = () => false,
  onPointerDownHit = null,
  onSuppressedMove = null,
  onSuppressedUp = null,
  onTap = null,
  onHover = null,
  onViewportChange = null,
} = {}) {
  if (!canvas || typeof canvasPoint !== 'function') {
    return { destroy() {} };
  }

  // 确保触控不被浏览器默认手势抢走（CSS 也可能设置；此处双保险）
  try {
    if (canvas.style && !canvas.style.touchAction) {
      canvas.style.touchAction = 'none';
    }
  } catch { /* ignore */ }

  let pan = null; // { pointerId, lastY, originY, moved }
  let suppressed = false; // ring / consume 占用指针

  function viewHeight() {
    return canvas.clientHeight || canvas.height || 1;
  }

  function notify() {
    if (typeof onViewportChange === 'function') onViewportChange();
  }

  function hitAt(event) {
    if (typeof renderer?.hitTest !== 'function') return null;
    const { x, y } = canvasPoint(event);
    return renderer.hitTest(x, y);
  }

  function onWheel(event) {
    if (isBlocked()) return;
    event.preventDefault();
    const { ok } = applyViewportDelta(renderer, wheelDeltaToBands(event.deltaY, viewHeight()));
    if (ok) notify();
  }

  function onPointerDown(event) {
    if (isBlocked()) return;
    if (event.button != null && event.button !== 0) return;
    suppressed = false;
    const hit = hitAt(event);
    if (typeof onPointerDownHit === 'function') {
      const mode = onPointerDownHit(hit, event);
      if (mode === 'ring' || mode === 'consume') {
        suppressed = true;
        try { canvas.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
        return;
      }
    }
    pan = {
      pointerId: event.pointerId,
      lastY: event.clientY,
      originY: event.clientY,
      moved: false,
      startHit: hit,
      startEvent: event,
    };
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
  }

  function onPointerMove(event) {
    if (suppressed) {
      if (typeof onSuppressedMove === 'function') onSuppressedMove(event);
      return;
    }
    if (typeof onHover === 'function') {
      onHover(event, hitAt(event));
    }
    if (!pan || pan.pointerId !== event.pointerId) return;
    const total = Math.abs(event.clientY - pan.originY);
    if (!pan.moved && total < PAN_THRESHOLD_PX) return;
    const dy = event.clientY - pan.lastY;
    pan.moved = true;
    pan.lastY = event.clientY;
    const { ok } = applyViewportDelta(renderer, panPixelsToBands(dy, viewHeight()));
    if (ok) notify();
  }

  function endPointer(event) {
    const isCancel = event?.type === 'pointercancel';
    if (suppressed) {
      suppressed = false;
      try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
      if (typeof onSuppressedUp === 'function') onSuppressedUp(event);
      return;
    }
    if (!pan || pan.pointerId !== event.pointerId) return;
    const wasPan = pan.moved;
    const startEvent = pan.startEvent;
    const startHit = pan.startHit;
    pan = null;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
    // pointercancel：结束手势但不触发 tap（避免误接管）
    if (!wasPan && !isCancel && typeof onTap === 'function' && startEvent) {
      onTap(startHit, startEvent);
    }
  }

  function onPointerLeave() {
    if (typeof onHover === 'function') onHover(null, null);
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', onPointerLeave);

  return {
    destroy() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', endPointer);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    },
  };
}
