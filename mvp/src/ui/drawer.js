// 右侧信息页 overlay drawer：桌面覆盖舞台不改 Canvas 尺寸；移动端 bottom sheet。
// 支持按钮 / Escape、aria-expanded / aria-controls、localStorage 记忆。
// 开关不得触发播放 / 接管 / 世界更新（调用方负责不把 onChange 接到那些路径）。

export const DRAWER_STORAGE_KEY = 'lcs-drawer-open-v1';
export const MOBILE_MQ = '(max-width: 720px)';

/**
 * @param {object} opts
 * @param {Element} opts.drawer
 * @param {Element} opts.toggle
 * @param {Storage|null} [opts.storage]
 * @param {string} [opts.storageKey]
 * @param {() => boolean} [opts.isMobile]
 * @param {(open: boolean) => void} [opts.onChange] 仅 UI；勿接 setTreeControl / setPaused
 * @param {Document|Window} [opts.doc]
 * @returns {{ isOpen: () => boolean, open: () => void, close: () => void, toggle: () => void, destroy: () => void }}
 */
export function createInfoDrawer({
  drawer,
  toggle,
  storage = null,
  storageKey = DRAWER_STORAGE_KEY,
  isMobile = null,
  onChange = null,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  if (!drawer || !toggle) {
    return {
      isOpen: () => false,
      open() {},
      close() {},
      toggle() {},
      destroy() {},
    };
  }

  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  const mobileCheck = typeof isMobile === 'function'
    ? isMobile
    : () => {
      try {
        return typeof matchMedia === 'function' && matchMedia(MOBILE_MQ).matches;
      } catch {
        return false;
      }
    };

  const drawerId = drawer.id || 'info-drawer';
  if (!drawer.id) drawer.id = drawerId;
  toggle.setAttribute('aria-controls', drawerId);
  drawer.setAttribute('role', 'complementary');

  function readStored() {
    if (!store) return false;
    try {
      const raw = store.getItem(storageKey);
      if (raw == null) return false; // 首次默认关闭，全幅舞台
      return raw === '1' || raw === 'true';
    } catch {
      return false;
    }
  }

  function writeStored(open) {
    if (!store) return;
    try { store.setItem(storageKey, open ? '1' : '0'); } catch { /* private mode */ }
  }

  let openState = readStored();

  function apply() {
    const mobile = !!mobileCheck();
    drawer.classList.toggle('is-open', openState);
    drawer.classList.toggle('is-closed', !openState);
    drawer.classList.toggle('is-sheet', mobile);
    drawer.classList.toggle('is-overlay', !mobile);
    drawer.setAttribute('aria-hidden', openState ? 'false' : 'true');
    toggle.setAttribute('aria-expanded', openState ? 'true' : 'false');
    toggle.classList.toggle('is-open', openState);
    toggle.textContent = openState ? '收起信息' : '信息';
    toggle.title = openState ? '隐藏右侧信息页（Esc）' : '展开右侧信息页';
    if (typeof onChange === 'function') onChange(openState);
  }

  function setOpen(next) {
    const want = !!next;
    if (want === openState) {
      apply();
      return;
    }
    openState = want;
    writeStored(openState);
    apply();
  }

  function onToggleClick(event) {
    event?.preventDefault?.();
    setOpen(!openState);
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (!openState) return;
    // 让调用方可在 capture 阶段先处理 USER 焦点；此处仅关 drawer。
    event.stopPropagation?.();
    setOpen(false);
  }

  toggle.addEventListener('click', onToggleClick);
  const keyTarget = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  keyTarget?.addEventListener?.('keydown', onKeydown, true);

  apply();

  return {
    isOpen: () => openState,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!openState),
    destroy() {
      toggle.removeEventListener('click', onToggleClick);
      keyTarget?.removeEventListener?.('keydown', onKeydown, true);
    },
  };
}
