import { createViewApp } from '/mvp/src/view-app.js';

export function createHistoricalShadowApp({ browserRuntime, renderer, ui }) {
  if (typeof browserRuntime?.start !== 'function' || typeof browserRuntime?.stop !== 'function') {
    throw new Error('HISTORICAL_SHADOW_RUNTIME_REQUIRED');
  }
  const view = createViewApp({ snapshotSource: browserRuntime, audioPlayer: null, renderer, ui });
  return Object.freeze({
    async start() {
      await browserRuntime.start();
      view.bind();
      return true;
    },
    async stop() {
      view.unbind();
      await browserRuntime.stop();
    },
  });
}

if (typeof window !== 'undefined') {
  const candidate = await import('./candidate-main.js');
  const app = createHistoricalShadowApp({
    browserRuntime: candidate.candidateBrowserRuntime,
    renderer: candidate.candidateRenderer,
    ui: candidate.candidateUi,
  });
  candidate.installCandidateRuntime(app);
  try { await app.start(); }
  catch (error) {
    const status = document.querySelector('[data-runtime-status]');
    if (status) status.textContent = error.code ?? error.message;
    throw error;
  }
}
