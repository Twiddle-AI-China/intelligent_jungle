// 年轮 DOM 可访问控件：有标签、可聚焦、可键盘调节；与 canvas/audio 同步。

import {
  DEFAULT_RING_RANGES,
  RING_PARAM_KEYS,
  applyRingParam,
  readRingValues,
} from './ring-bridge.js';

export const RING_A11Y_LABELS = Object.freeze({
  eqLowDb: 'EQ 低',
  eqMidDb: 'EQ 中',
  eqHighDb: 'EQ 高',
  reverbSend: 'FX · Reverb',
  pingPongSend: 'FX · Ping-pong',
  gain: 'Volume',
});

export const EQ_CYCLE_KEYS = Object.freeze(['eqLowDb', 'eqMidDb', 'eqHighDb']);

/**
 * 从 getRingControls（若有）或默认范围，取出当前声部的控件描述。
 */
export function ringControlSpecs(renderer, treeId) {
  const fromRenderer = typeof renderer?.getRingControls === 'function'
    ? (renderer.getRingControls() ?? []).filter((c) => c.treeId === treeId)
    : [];
  const byKey = Object.fromEntries(fromRenderer.map((c) => [c.controlId, c]));
  return RING_PARAM_KEYS.map((key) => {
    const c = byKey[key];
    const range = DEFAULT_RING_RANGES[key];
    return {
      controlId: key,
      label: c?.label ?? RING_A11Y_LABELS[key] ?? key,
      min: c?.min ?? range[0],
      max: c?.max ?? range[1],
      step: c?.step ?? (range[1] - range[0]) / 40,
      value: c?.value,
    };
  });
}

/**
 * 生成可聚焦 range 控件 HTML（非纯展示）。
 */
export function ringA11yHtml(treeId, species, { renderer, audio } = {}) {
  const values = readRingValues({ renderer, audio, treeId, species });
  const specs = ringControlSpecs(renderer, treeId);
  const rows = specs.map((spec) => {
    const val = values[spec.controlId];
    const id = `ring-${treeId}-${spec.controlId}`;
    return `<label class="ring-a11y-row" for="${id}">
      <span class="ring-a11y-label">${spec.label}</span>
      <input type="range" id="${id}" class="ring-a11y-input"
        data-ring-key="${spec.controlId}"
        min="${spec.min}" max="${spec.max}" step="${spec.step}"
        value="${val}"
        aria-label="${spec.label}"
        aria-valuemin="${spec.min}" aria-valuemax="${spec.max}" aria-valuenow="${val}" />
      <output class="ring-a11y-val" data-ring-key="${spec.controlId}" for="${id}">${formatA11yValue(spec.controlId, val)}</output>
    </label>`;
  }).join('');
  return `<div class="ring-a11y" role="group" aria-label="当前声部混音">
    <p class="ring-a11y-hint">声部音色与空间 · 接管后可手动塑形</p>
    ${rows}
  </div>`;
}

export function formatA11yValue(key, value) {
  if (String(key).endsWith('Db')) {
    return `${value >= 0 ? '+' : ''}${Number(value).toFixed(1)} dB`;
  }
  return Number(value).toFixed(2);
}

/**
 * 把 live 值写回已挂载的 range/output（不重建 DOM，保留焦点）。
 */
export function syncRingA11yDom(root, treeId, species, { renderer, audio } = {}) {
  if (!root) return;
  const values = readRingValues({ renderer, audio, treeId, species });
  const specs = ringControlSpecs(renderer, treeId);
  const byKey = Object.fromEntries(specs.map((s) => [s.controlId, s]));
  for (const key of RING_PARAM_KEYS) {
    const input = root.querySelector(`input.ring-a11y-input[data-ring-key="${key}"]`);
    const out = root.querySelector(`output.ring-a11y-val[data-ring-key="${key}"]`);
    const val = values[key];
    const spec = byKey[key];
    if (input) {
      if (spec) {
        if (input.min !== String(spec.min)) input.min = String(spec.min);
        if (input.max !== String(spec.max)) input.max = String(spec.max);
        if (input.step !== String(spec.step)) input.step = String(spec.step);
      }
      // 用户正在拖动时不要抢值
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (active !== input && input.value !== String(val)) {
        input.value = String(val);
      }
      input.setAttribute('aria-valuenow', String(val));
    }
    if (out) {
      const text = formatA11yValue(key, val);
      if (out.textContent !== text) out.textContent = text;
    }
  }
}

/**
 * 给 ring-a11y 根节点接线 input 事件 → applyRingParam。
 */
export function bindRingA11yInputs(root, {
  renderer, audio, trees, getTreeId, onChange = null,
} = {}) {
  if (!root || root.dataset.ringBound === '1') return;
  root.dataset.ringBound = '1';
  root.addEventListener('input', (event) => {
    const input = event.target;
    if (!input || input.tagName !== 'INPUT') return;
    if (!input.classList?.contains?.('ring-a11y-input')
      && !(typeof input.className === 'string' && input.className.includes('ring-a11y-input'))) {
      return;
    }
    const controlId = input.dataset?.ringKey;
    const treeId = typeof getTreeId === 'function' ? getTreeId() : null;
    if (!controlId || treeId == null) return;
    const tree = (trees ?? []).find((entry) => entry.id === treeId);
    const before = readRingValues({ renderer, audio, treeId, species: tree?.species })[controlId];
    const result = applyRingParam({
      renderer, audio, trees, treeId, controlId, value: Number(input.value),
    });
    if (result.ok) {
      const out = root.querySelector(`output.ring-a11y-val[data-ring-key="${controlId}"]`);
      if (out) out.textContent = formatA11yValue(controlId, result.value);
      input.setAttribute?.('aria-valuenow', String(result.value));
      if (typeof onChange === 'function') onChange(treeId, controlId, result.value, before);
    }
  });
}

/**
 * Alt+←/→：在 EQ 三环间循环并步进调节。
 * @returns {{ controlId: string, nextIndex: number }|null}
 */
export function nextEqCycleTarget(forVoiceControls, eqIndex, dir) {
  const eq = (forVoiceControls ?? []).filter((c) => EQ_CYCLE_KEYS.includes(c.controlId));
  if (!eq.length) return null;
  const len = eq.length;
  const idx = ((Number(eqIndex) || 0) % len + len) % len;
  const target = eq[idx];
  const nextIndex = (idx + (dir >= 0 ? 1 : len - 1)) % len;
  return { controlId: target.controlId, value: target.value, step: target.step, treeId: target.treeId, nextIndex };
}
