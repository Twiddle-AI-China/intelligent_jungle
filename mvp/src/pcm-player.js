const DISABLED_STATUS = Object.freeze({
  state: 'disabled',
  bufferedFrames: 0,
});

function disabledError() {
  const code = 'PCM_DISABLED_PHASE_1_2';
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Phase 1–2 只冻结播放器接口，所有 owner 组合都不得产生音频或网络副作用。
 * 依赖在 Phase 5 才会启用；当前实现刻意不解构、不检查、更不调用它们。
 */
export function createPcmPlayer(_dependencies = {}) {
  return Object.freeze({
    async start() {
      throw disabledError();
    },
    stop() {},
    reset() {},
    getStatus() {
      return DISABLED_STATUS;
    },
  });
}
