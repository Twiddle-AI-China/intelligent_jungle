function appError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createViewApp({ snapshotSource, audioPlayer, renderer, ui }) {
  if (typeof snapshotSource?.subscribe !== 'function'
      || typeof renderer?.render !== 'function'
      || typeof ui?.render !== 'function') {
    throw appError('VIEW_APP_DEPENDENCIES_REQUIRED');
  }

  let unsubscribe = null;
  return Object.freeze({
    bind() {
      if (unsubscribe !== null) return unsubscribe;
      const release = snapshotSource.subscribe((snapshot) => {
        renderer.render(snapshot);
        ui.render(snapshot);
      });
      unsubscribe = typeof release === 'function' ? release : () => {};
      return unsubscribe;
    },
    unbind() {
      const release = unsubscribe;
      unsubscribe = null;
      release?.();
    },
    async startAudio() { return audioPlayer?.start?.(); },
    stopAudio() { return audioPlayer?.stop?.(); },
  });
}

export function createServerOwnedApp({ runtimeClient, pcmPlayer, renderer, ui }) {
  if (typeof runtimeClient?.connect !== 'function'
      || typeof runtimeClient?.disconnect !== 'function'
      || typeof runtimeClient?.getStatus !== 'function') {
    throw appError('SERVER_APP_DEPENDENCIES_REQUIRED');
  }
  const view = createViewApp({
    snapshotSource: runtimeClient,
    audioPlayer: pcmPlayer,
    renderer,
    ui,
  });
  let started = false;
  let starting = null;

  async function startOnce() {
    try {
      await runtimeClient.connect();
      if (runtimeClient.getStatus().runtimeOwner !== 'server') {
        throw appError('SERVER_OWNER_TUPLE_NOT_READY');
      }
      view.bind();
      await view.startAudio();
      started = true;
      return true;
    } catch (error) {
      view.stopAudio();
      view.unbind();
      runtimeClient.disconnect();
      throw error;
    } finally {
      starting = null;
    }
  }

  return Object.freeze({
    start() {
      if (started) return Promise.resolve(true);
      if (starting !== null) return starting;
      starting = startOnce();
      return starting;
    },
    async stop() {
      view.stopAudio();
      view.unbind();
      runtimeClient.disconnect();
      started = false;
    },
  });
}
