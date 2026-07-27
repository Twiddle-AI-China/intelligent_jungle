import { createPcmPlayer } from './pcm-player.js';
import { createRenderer } from './renderer.js';
import { createRuntimeClient } from './runtime-client.js';
import { createServerOwnedApp } from './view-app.js';
import { createLatentRoamer } from './ui/latent-roamer.js';
import {
  defaultViewSequenceDimensions,
  sequencePlayheadForViewTree,
} from './view-sequence.js';

const RUNTIME_BASE_URL = 'http://127.0.0.1:18090';

function socketUrl(path) {
  const url = new URL(path, RUNTIME_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
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
    const ratio = Math.max(1, window.devicePixelRatio || 1);
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
      announce('server runtime ready');
    },
    fail(error) { announce(error?.code ?? 'runtime unavailable'); },
  });
}

export function createBrowserProductionApp({ document, window }) {
  const runtimeClient = createRuntimeClient({
    fetchImpl: (url, options) => {
      if (url !== 'http://127.0.0.1:18090/api/v1/bootstrap') {
        return Promise.reject(new Error('PRODUCTION_BOOTSTRAP_URL_REJECTED'));
      }
      return window.fetch('http://127.0.0.1:18090/api/v1/bootstrap', options);
    },
    webSocketFactory: (url) => new window.WebSocket(url),
    baseUrl: RUNTIME_BASE_URL,
  });
  const pcmPlayer = createPcmPlayer({
    runtimeClient,
    audioContextFactory: (options) => new window.AudioContext(options),
    webSocketFactory: (path) => new window.WebSocket(socketUrl(path)),
  });
  const canvas = document.querySelector('#scene');
  const renderer = createRenderer(canvas);
  renderer.setEntryMode(true);
  const ui = createProductionUi({ document, window, runtimeClient, renderer });
  const latentRoamer = createLatentRoamer({
    document,
    runtimeClient,
    getState: ui.getSnapshot,
    fetchMap: async (voice) => {
      let response;
      if (voice === 'bass') response = await window.fetch(
        'http://127.0.0.1:18090/api/v1/latent-maps/bass',
      );
      else if (voice === 'pad') response = await window.fetch(
        'http://127.0.0.1:18090/api/v1/latent-maps/pad',
      );
      else response = await window.fetch(
        'http://127.0.0.1:18090/api/v1/latent-maps/melody',
      );
      if (!response.ok) throw new Error('LATENT_MAP_UNAVAILABLE');
      return response.json();
    },
  });
  ui.setSnapshotObserver((snapshot) => latentRoamer.render(snapshot));
  for (const button of document.querySelectorAll('[data-open-latent]')) {
    button.addEventListener('click', () => latentRoamer.open(button.dataset.openLatent)
      .catch((error) => ui.fail(error)));
  }
  const app = createServerOwnedApp({ runtimeClient, pcmPlayer, renderer, ui });
  ui.resize();
  ui.startButton?.addEventListener('click', () => {
    ui.startButton.disabled = true;
    app.start().then(() => ui.enter()).catch((error) => {
      ui.startButton.disabled = false;
      ui.fail(error);
    });
  });
  window.addEventListener('beforeunload', () => { app.stop(); }, { once: true });
  return Object.freeze({ app, runtimeClient, pcmPlayer, renderer, ui, latentRoamer });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  createBrowserProductionApp({ document, window });
}
