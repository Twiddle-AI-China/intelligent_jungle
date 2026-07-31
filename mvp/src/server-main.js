import { createPcmPlayer } from './pcm-player.js';
import { createRenderer } from './renderer.js';
import { createRuntimeClient } from './runtime-client.js';
import { createServerOwnedApp } from './view-app.js';
import { createLatentRoamer } from './ui/latent-roamer.js';
import {
  defaultViewSequenceDimensions,
  sequencePlayheadForViewTree,
} from './view-sequence.js';

function originError() {
  const error = new Error('RUNTIME_ORIGIN_INVALID');
  error.code = 'RUNTIME_ORIGIN_INVALID';
  return error;
}

function productionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export const MAX_CANVAS_PIXEL_RATIO = 1.5;
export const MAX_SCENE_FPS = 30;
export const MAX_SCENE_EXTRAPOLATION_MS = 1_000;

export function projectSnapshotForRender(snapshot, elapsedMs) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.paused === true) return snapshot;
  const elapsedSeconds = Math.min(MAX_SCENE_EXTRAPOLATION_MS,
    Math.max(0, Number(elapsedMs) || 0)) / 1_000;
  const dayLength = Number(snapshot.dayLength);
  const phase = Number(snapshot.phase);
  const simTime = Number(snapshot.simTime);
  if (elapsedSeconds === 0 || !Number.isFinite(dayLength) || dayLength <= 0
      || !Number.isFinite(phase) || !Number.isFinite(simTime)) return snapshot;
  const absolutePhase = phase + elapsedSeconds / dayLength;
  const dayAdvance = Math.floor(absolutePhase);
  return {
    ...snapshot,
    simTime: simTime + elapsedSeconds,
    phase: absolutePhase - dayAdvance,
    ...(Number.isSafeInteger(snapshot.day)
      ? { day: snapshot.day + dayAdvance }
      : {}),
  };
}

export function createFrameCappedRenderer({ renderer, window,
  maxFps = MAX_SCENE_FPS } = {}) {
  if (!renderer || typeof renderer.render !== 'function'
      || typeof window?.requestAnimationFrame !== 'function'
      || !Number.isFinite(maxFps) || maxFps <= 0) {
    throw productionError('RENDER_SCHEDULER_DEPENDENCIES_REQUIRED');
  }
  const intervalMs = 1_000 / maxFps;
  let latestSnapshot = null;
  let latestReceivedAt = null;
  let scheduled = false;
  let lastPaintAt = null;

  function paint(now) {
    if (latestSnapshot === null) return;
    if (lastPaintAt !== null && Number.isFinite(now)
        && now - lastPaintAt < intervalMs) {
      window.requestAnimationFrame(paint);
      return;
    }
    lastPaintAt = Number.isFinite(now) ? now : 0;
    renderer.render(projectSnapshotForRender(
      latestSnapshot,
      latestReceivedAt === null ? 0 : lastPaintAt - latestReceivedAt,
    ));
    window.requestAnimationFrame(paint);
  }

  function schedule() {
    if (scheduled || latestSnapshot === null) return;
    scheduled = true;
    window.requestAnimationFrame(paint);
  }

  return Object.freeze({
    render(snapshot) {
      latestSnapshot = snapshot;
      latestReceivedAt = Number(window.performance?.now?.()) || 0;
      schedule();
    },
    resize() { renderer.resize?.(); },
    setEntryMode(value) { renderer.setEntryMode?.(value); },
    hitTest(...args) { return renderer.hitTest?.(...args) ?? null; },
    focusVoice(...args) { return renderer.focusVoice?.(...args); },
  });
}

export function deriveRuntimeEndpoints(origin) {
  if (typeof origin !== 'string') throw originError();
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw originError();
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.origin !== origin
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== '') {
    throw originError();
  }
  const socketOrigin = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}`;
  const latentMapUrls = Object.freeze({
    bass: `${origin}/api/v1/latent-maps/bass`,
    pad: `${origin}/api/v1/latent-maps/pad`,
    melody: `${origin}/api/v1/latent-maps/melody`,
  });
  return Object.freeze({
    baseUrl: origin,
    bootstrapUrl: `${origin}/api/v1/bootstrap`,
    runtimeWebSocketUrl: `${socketOrigin}/api/v1/runtime`,
    audioWebSocketUrl: `${socketOrigin}/api/v1/audio`,
    latentMapUrls,
  });
}

export function createBrowserRuntimeTransport({ document, window } = {}) {
  if (!document || typeof document.baseURI !== 'string'
      || !window
      || typeof window.WebSocket !== 'function') {
    throw productionError('PRODUCTION_TRANSPORT_DEPENDENCIES_REQUIRED');
  }
  const endpoints = deriveRuntimeEndpoints(window.location.origin);
  const latentTargets = Object.freeze({
    bass: Object.freeze({
      literalPath: '/api/v1/latent-maps/bass',
      derivedUrl: endpoints.latentMapUrls.bass,
    }),
    pad: Object.freeze({
      literalPath: '/api/v1/latent-maps/pad',
      derivedUrl: endpoints.latentMapUrls.pad,
    }),
    melody: Object.freeze({
      literalPath: '/api/v1/latent-maps/melody',
      derivedUrl: endpoints.latentMapUrls.melody,
    }),
  });

  function assertHttpTarget(literalPath, expectedUrl) {
    let endpointTarget;
    let documentTarget;
    try {
      endpointTarget = new URL(literalPath, endpoints.baseUrl).toString();
      documentTarget = new URL(literalPath, document.baseURI).toString();
    } catch {
      throw productionError('PRODUCTION_HTTP_TARGET_REJECTED');
    }
    if (endpointTarget !== expectedUrl || documentTarget !== expectedUrl) {
      throw productionError('PRODUCTION_HTTP_TARGET_REJECTED');
    }
  }

  async function fetchBootstrap(url, options) {
    if (url !== endpoints.bootstrapUrl) {
      throw productionError('PRODUCTION_BOOTSTRAP_URL_REJECTED');
    }
    assertHttpTarget('/api/v1/bootstrap', endpoints.bootstrapUrl);
    return window.fetch('/api/v1/bootstrap', options);
  }

  function openRuntimeSocket(url) {
    if (url !== endpoints.runtimeWebSocketUrl) {
      throw productionError('PRODUCTION_RUNTIME_SOCKET_URL_REJECTED');
    }
    return new window.WebSocket(endpoints.runtimeWebSocketUrl);
  }

  function openAudioSocket(path) {
    if (path !== '/api/v1/audio') {
      throw productionError('PRODUCTION_AUDIO_SOCKET_URL_REJECTED');
    }
    return new window.WebSocket(endpoints.audioWebSocketUrl);
  }

  async function fetchLatentMap(voice) {
    if (!Object.hasOwn(latentTargets, voice)) {
      throw productionError('LATENT_MAP_UNAVAILABLE');
    }
    const target = latentTargets[voice];
    assertHttpTarget(target.literalPath, target.derivedUrl);
    let response;
    if (target.literalPath === '/api/v1/latent-maps/bass') {
      response = await window.fetch('/api/v1/latent-maps/bass');
    } else if (target.literalPath === '/api/v1/latent-maps/pad') {
      response = await window.fetch('/api/v1/latent-maps/pad');
    } else if (target.literalPath === '/api/v1/latent-maps/melody') {
      response = await window.fetch('/api/v1/latent-maps/melody');
    } else {
      throw productionError('LATENT_MAP_UNAVAILABLE');
    }
    if (!response.ok) throw productionError('LATENT_MAP_UNAVAILABLE');
    return response.json();
  }

  return Object.freeze({
    endpoints,
    fetchBootstrap,
    openRuntimeSocket,
    openAudioSocket,
    fetchLatentMap,
  });
}

export function createProductionUi({ document, window, runtimeClient, renderer }) {
  const status = document.querySelector('[data-runtime-status]');
  const canvas = document.querySelector('#scene');
  const startButton = document.querySelector('#start-btn');
  const overlay = document.querySelector('#overlay');
  let latestSnapshot = null;
  let snapshotObserver = () => {};

  function announce(value) {
    if (status) status.textContent = value;
  }

  function send(name, payload) {
    return runtimeClient.command(name, payload).then((result) => {
      announce(result.accepted ? 'server runtime ready' : `intent rejected: ${result.code}`);
      return result;
    }).catch((error) => {
      announce(error?.code ?? 'runtime disconnected');
      return null;
    });
  }

  function resize() {
    const ratio = Math.min(MAX_CANVAS_PIXEL_RATIO,
      Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    renderer.resize();
    if (latestSnapshot) renderer.render(latestSnapshot);
  }

  canvas.addEventListener('click', (event) => {
    if (!latestSnapshot) return;
    const rect = canvas.getBoundingClientRect();
    const hit = renderer.hitTest(
      (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width),
      (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height),
    );
    if (hit?.type === 'sequence') {
      send('sequence.toggle', {
        treeId: hit.treeId, pitchBranchId: hit.pitchBranchId, stepIndex: hit.stepIndex,
      });
    } else if (hit?.type === 'branch') {
      const tree = latestSnapshot.trees.find(({ id }) => id === hit.treeId);
      const dimensions = defaultViewSequenceDimensions();
      const playhead = sequencePlayheadForViewTree({ ...tree,
        phase: latestSnapshot.phase }, dimensions);
      send('sequence.place', { treeId: hit.treeId, pitchBranchId: hit.branchId,
        stepIndex: playhead.stepIndex, stepCount: dimensions.stepCount });
    } else if (hit?.type === 'bird') {
      send('bird.shoo', { birdId: hit.birdId });
    } else if (hit?.type === 'tree') {
      renderer.focusVoice(hit.treeId);
    }
  });

  for (const button of document.querySelectorAll('[data-bpm]')) {
    button.addEventListener('click', () => send('transport.setTempo', {
      bpm: Number(button.dataset.bpm),
    }));
  }
  document.querySelector('#master-meter')?.addEventListener('change', (event) => {
    send('transport.setMeter', { beatsPerBar: Number(event.target.value) });
  });
  window.addEventListener('resize', resize);

  return Object.freeze({
    startButton,
    resize,
    render(snapshot) {
      latestSnapshot = snapshot;
      snapshotObserver(snapshot);
      announce('server runtime ready');
      const runtimeStatus = runtimeClient.getStatus();
      const generation = document.querySelector('[data-world-generation]');
      const revision = document.querySelector('[data-revision]');
      if (generation) generation.textContent = runtimeStatus.worldGeneration ?? '';
      if (revision) revision.textContent = String(runtimeStatus.revision);
      const day = document.querySelector('#master-day-fact');
      if (day) day.textContent = `第 ${snapshot.day ?? 1} 天`;
    },
    getSnapshot: () => latestSnapshot,
    setSnapshotObserver(observer) { snapshotObserver = observer; },
    enter() {
      renderer.setEntryMode(false);
      overlay?.classList.add('hidden');
      announce('runtime connecting');
    },
    retry(error) {
      renderer.setEntryMode(true);
      overlay?.classList.remove('hidden');
      announce(error?.code ?? 'runtime unavailable');
    },
    fail(error) { announce(error?.code ?? 'runtime unavailable'); },
  });
}

export function createBrowserProductionApp({ document, window }) {
  const transport = createBrowserRuntimeTransport({ document, window });
  const { endpoints } = transport;
  const runtimeClient = createRuntimeClient({
    fetchImpl: transport.fetchBootstrap,
    webSocketFactory: transport.openRuntimeSocket,
    baseUrl: endpoints.baseUrl,
  });
  const pcmPlayer = createPcmPlayer({
    runtimeClient,
    audioContextFactory: (options) => new window.AudioContext(options),
    webSocketFactory: transport.openAudioSocket,
  });
  const canvas = document.querySelector('#scene');
  const renderer = createFrameCappedRenderer({ renderer: createRenderer(canvas), window });
  renderer.setEntryMode(true);
  const ui = createProductionUi({ document, window, runtimeClient, renderer });
  const latentRoamer = createLatentRoamer({
    document,
    runtimeClient,
    getState: ui.getSnapshot,
    fetchMap: transport.fetchLatentMap,
  });
  ui.setSnapshotObserver((snapshot) => latentRoamer.render(snapshot));
  for (const button of document.querySelectorAll('[data-open-latent]')) {
    button.addEventListener('click', () => latentRoamer.open(button.dataset.openLatent)
      .catch((error) => ui.fail(error)));
  }
  const app = createServerOwnedApp({ runtimeClient, pcmPlayer, renderer, ui });
  ui.resize();
  if (ui.startButton) {
    ui.startButton.disabled = false;
    ui.startButton.textContent = '进入';
  }
  ui.startButton?.addEventListener('click', () => {
    ui.startButton.disabled = true;
    ui.startButton.textContent = '连接中…';
    ui.enter();
    app.start().catch((error) => {
      ui.startButton.disabled = false;
      ui.startButton.textContent = '重试';
      ui.retry(error);
    });
  });
  window.addEventListener('beforeunload', () => { app.stop(); }, { once: true });
  return Object.freeze({ app, runtimeClient, pcmPlayer, renderer, ui, latentRoamer });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  createBrowserProductionApp({ document, window });
}
