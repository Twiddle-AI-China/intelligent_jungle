// 左侧声部定位器：浏览相机到声部区，不切换 USER / 不改混音。
// 对尚未落地的 renderer 相机接口做存在性保护。

export const VOICE_ORDER = Object.freeze(['pad', 'melody', 'bass', 'texture']);

export const VOICE_LABELS = Object.freeze({
  pad: 'Pad',
  melody: 'Melody',
  bass: 'Bass',
  texture: 'Texture',
});

/**
 * 尝试把相机移到指定声部。优先 focusVoice；否则无操作（不抛错）。
 * 绝不调用 setTreeControl / setZoomFocus / toggleFocusTree。
 * @param {object|null|undefined} renderer
 * @param {string} voiceId
 * @returns {{ ok: boolean, method: string|null }}
 */
export function browseToVoice(renderer, voiceId) {
  if (!renderer || voiceId == null) return { ok: false, method: null };
  if (typeof renderer.focusVoice === 'function') {
    renderer.focusVoice(voiceId);
    return { ok: true, method: 'focusVoice' };
  }
  return { ok: false, method: null };
}

/**
 * 按相对方向浏览相邻声部（上 = 列表更前）。
 * 优先 moveViewportBy；否则对相邻 id 调 focusVoice。
 * @returns {{ ok: boolean, voiceId: string|null, method: string|null }}
 */
export function browseVoiceByDelta(renderer, currentId, delta, voices = VOICE_ORDER) {
  const list = Array.isArray(voices) && voices.length ? voices : VOICE_ORDER;
  const idx = list.indexOf(currentId);
  const from = idx >= 0 ? idx : 0;
  const next = Math.max(0, Math.min(list.length - 1, from + Number(delta || 0)));
  const voiceId = list[next];
  if (!renderer) return { ok: false, voiceId, method: null };

  if (typeof renderer.moveViewportBy === 'function' && Number(delta) !== 0) {
    // 符号约定：delta<0 向上（更小 index），世界 Y 减小；具体比例由 renderer 解释。
    renderer.moveViewportBy(Number(delta));
    return { ok: true, voiceId, method: 'moveViewportBy' };
  }
  const browsed = browseToVoice(renderer, voiceId);
  return { ok: browsed.ok, voiceId, method: browsed.method };
}

/**
 * 读取当前视口声部：仅 getVisibleVoice → fallback。
 * 不回落 getFocusTree，避免浏览高亮与 USER 接管混淆。
 * @param {object|null|undefined} renderer
 * @param {string} [fallback='pad']
 */
export function resolveVisibleVoice(renderer, fallback = 'pad') {
  if (renderer?.getCameraMode?.() === 'overview') return null;
  if (renderer && typeof renderer.getVisibleVoice === 'function') {
    const v = renderer.getVisibleVoice();
    if (v != null && v !== '') return v;
  }
  return fallback;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {object} opts
 * @param {Element} opts.root
 * @param {object} [opts.renderer]
 * @param {readonly string[]} [opts.voices]
 * @param {Record<string,string>} [opts.labels]
 * @param {Document} [opts.doc]
 * @param {(voiceId: string, meta: { method: string|null, ok: boolean }) => void} [opts.onBrowse]
 *   仅 UI 回调；调用方不得在此切 USER。
 */
export function createVoiceLocator({
  root,
  renderer = null,
  voices = VOICE_ORDER,
  labels = VOICE_LABELS,
  onBrowse = null,
  onOverview = null,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  if (!root || !doc?.createElement) {
    return {
      getActive: () => voices[0] ?? 'pad',
      setActive() {},
      refresh() {},
      destroy() {},
    };
  }

  let active = resolveVisibleVoice(renderer, voices[0] ?? 'pad');
  const buttons = new Map();
  const cleanups = [];

  root.classList.add('voice-locator');
  root.setAttribute('aria-label', '声部定位器');
  root.innerHTML = '';

  const overview = el(doc, 'button', 'voice-locator-overview', '全树');
  overview.type = 'button';
  overview.title = '返回全树 overview';
  const onOverviewClick = () => {
    renderer?.setCameraMode?.('overview');
    active = null;
    paint();
    if (typeof onOverview === 'function') onOverview();
  };
  overview.addEventListener('click', onOverviewClick);
  cleanups.push(() => overview.removeEventListener('click', onOverviewClick));
  root.appendChild(overview);
  root.appendChild(el(doc, 'div', 'voice-locator-title', '声部'));

  const list = el(doc, 'div', 'voice-locator-list');
  list.setAttribute('role', 'list');

  for (const id of voices) {
    const btn = el(doc, 'button', 'voice-locator-btn', labels[id] ?? id);
    btn.type = 'button';
    btn.dataset.voice = id;
    btn.title = `浏览到 ${labels[id] ?? id}（不接管）`;
    btn.setAttribute('aria-pressed', 'false');
    const onClick = (event) => {
      event?.preventDefault?.();
      setActive(id, { browse: true });
    };
    btn.addEventListener('click', onClick);
    cleanups.push(() => btn.removeEventListener('click', onClick));
    buttons.set(id, btn);
    list.appendChild(btn);
  }
  root.appendChild(list);
  root.appendChild(el(doc, 'div', 'voice-locator-hint', '↑↓ 浏览 · 点枝接管\n←/→ 年轮'));

  function paint() {
    for (const [id, btn] of buttons) {
      const on = id === active;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function setActive(id, { browse = false } = {}) {
    if (!voices.includes(id)) return;
    active = id;
    if (browse) {
      const meta = browseToVoice(renderer, id);
      if (typeof onBrowse === 'function') onBrowse(id, meta);
    }
    paint();
  }

  function refresh() {
    active = resolveVisibleVoice(renderer, active);
    paint();
  }

  paint();

  return {
    getActive: () => active,
    setActive,
    refresh,
    destroy() {
      for (const off of cleanups) off();
      cleanups.length = 0;
      buttons.clear();
      root.innerHTML = '';
    },
  };
}
