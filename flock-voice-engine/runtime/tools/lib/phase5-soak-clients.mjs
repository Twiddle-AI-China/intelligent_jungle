import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import WebSocket from 'ws';

const CAPABILITY_HEADER = 'x-flock-phase5-client-capability';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { throw new Error(code); };

function clock() {
  return Object.freeze({
    atMonotonicMs: Math.round(performance.now()),
    atUnixMs: Date.now(),
  });
}

function openWebSocket(url, capability) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      origin: 'http://127.0.0.1:18090',
      headers: { [CAPABILITY_HEADER]: capability },
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('PHASE5_SOAK_WS_OPEN_TIMEOUT'));
    }, 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function closePromise(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}

export async function openPhase5SoakClients({
  admitted, latencyRecorder, clientRecorder,
  bootstrapUrl = 'http://127.0.0.1:18090/api/v1/bootstrap',
  runtimeUrl = 'ws://127.0.0.1:18090/api/v1/runtime',
  audioUrl = 'ws://127.0.0.1:18090/api/v1/audio',
} = {}) {
  if (!admitted?.descriptor || !Array.isArray(admitted.clientCapabilities)
      || admitted.clientCapabilities.length !== 4
      || typeof latencyRecorder?.runtimeOpened !== 'function'
      || typeof clientRecorder?.runtimeOpen !== 'function') {
    fail('PHASE5_SOAK_CLIENT_INPUT_INVALID');
  }
  const states = admitted.clientCapabilities.map((grant) => ({
    grant: { ...grant }, runtime: null, audio: null, resume: null,
    worldGeneration: null, revision: 0, eventSeq: 0,
    pendingProbe: null, recording: true,
  }));
  const windowEnd = admitted.descriptor.window.endedAtMonotonicMs;
  let terminal = false;

  function claim(state, socketKind) {
    return Object.freeze({
      client: state.grant.client,
      clientIdentitySha256: state.grant.clientIdentitySha256,
      socketKind,
      generation: state.grant[
        socketKind === 'runtime' ? 'runtimeGeneration' : 'audioGeneration'
      ],
    });
  }

  async function publicBootstrap() {
    const response = await fetch(bootstrapUrl, {
      headers: { origin: 'http://127.0.0.1:18090' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) fail('PHASE5_SOAK_BOOTSTRAP_FAILED');
    return response.json();
  }

  async function openRuntime(state, capability, generation) {
    const bootstrap = generation === 1 ? await publicBootstrap() : null;
    state.grant.runtimeCapability = capability;
    state.grant.runtimeGeneration = generation;
    const socket = await openWebSocket(runtimeUrl, capability);
    const opened = clock();
    state.runtime = socket;
    const runtimeClaim = claim(state, 'runtime');
    clientRecorder.runtimeOpen(runtimeClaim, opened,
      generation === 1 ? 'bootstrap' : 'resume');
    if (generation === 1) latencyRecorder.runtimeOpened({
      client: state.grant.client,
      connectionGeneration: 1,
      openedAtMonotonicMs: opened.atMonotonicMs,
      openedAtUnixMs: opened.atUnixMs,
    });
    let firstSnapshot = true;
    let resolveInitialSnapshot;
    const initialSnapshot = new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(
        new Error('PHASE5_SOAK_RUNTIME_READY_TIMEOUT'),
      ), 10_000);
      socket.on('message', (value, isBinary) => {
        try {
          if (isBinary || !state.recording) return;
          const bytes = Buffer.from(value);
          const frame = JSON.parse(bytes);
          const observed = clock();
          if (observed.atMonotonicMs > windowEnd) return;
          if (frame.type === 'snapshot') {
            const probe = firstSnapshot ? null : state.pendingProbe;
            clientRecorder.runtimeFrame(
              runtimeClaim, observed, bytes, probe?.probeSeq ?? null,
            );
            if (firstSnapshot) resolveInitialSnapshot();
            if (probe) {
              latencyRecorder.uiSnapshotObserved({
                client: state.grant.client,
                connectionGeneration: generation,
                probeSeq: probe.probeSeq,
                observedAtMonotonicMs: observed.atMonotonicMs,
                observedAtUnixMs: observed.atUnixMs,
                snapshotFrameSha256: sha256(bytes),
              });
              probe.resolve();
              state.pendingProbe = null;
            }
            firstSnapshot = false;
          }
          if (frame.type === 'ready') {
            state.resume = frame.resumeToken;
            state.worldGeneration = frame.worldGeneration;
            state.revision = frame.revision;
            state.eventSeq = frame.eventSeq;
            if (generation === 1) latencyRecorder.runtimeReady({
              client: state.grant.client,
              connectionGeneration: 1,
              readyAtMonotonicMs: observed.atMonotonicMs,
              readyAtUnixMs: observed.atUnixMs,
              readyFrameSha256: sha256(bytes),
            });
            clearTimeout(timer);
            resolve();
          }
          if (Number.isSafeInteger(frame.revision)) {
            state.revision = Math.max(state.revision, frame.revision);
          }
          if (Number.isSafeInteger(frame.resultRevision)) {
            state.revision = Math.max(state.revision, frame.resultRevision);
          }
        } catch (error) { terminal = true; reject(error); }
      });
    });
    socket.on('close', (code, reason) => {
      if (!state.recording) return;
      try {
        state.pendingProbe?.reject(new Error('PHASE5_SOAK_PROBE_CONNECTION_CLOSED'));
        state.pendingProbe = null;
        clientRecorder.runtimeClose(runtimeClaim, clock(), code || 1006,
          Buffer.from(reason).toString('utf8') || 'ABNORMAL_CLOSE');
      } catch { terminal = true; }
    });
    const hello = generation === 1 ? {
      type: 'hello', protocolVersion: 1, clientId: bootstrap.clientId,
      bootstrapToken: bootstrap.bootstrapToken,
      worldGeneration: bootstrap.worldGeneration,
      lastRevision: bootstrap.revision, lastEventSeq: bootstrap.eventSeq,
    } : {
      type: 'hello', protocolVersion: 1,
      clientId: state.grant.clientIdentitySha256,
      resumeToken: state.resume,
      worldGeneration: state.worldGeneration,
      lastRevision: state.revision, lastEventSeq: state.eventSeq,
    };
    socket.send(JSON.stringify(hello));
    await ready;
    if (generation > 1) {
      socket.send(JSON.stringify({
        type: 'command', protocolVersion: 1,
        commandId: `phase5-reconnect-snapshot-${state.grant.client}-${generation}`,
        worldGeneration: state.worldGeneration, baseRevision: state.revision,
        name: 'snapshot.request', payload: {},
      }));
    }
    await Promise.race([
      initialSnapshot,
      new Promise((_, reject) => setTimeout(() => reject(
        new Error('PHASE5_SOAK_RUNTIME_SNAPSHOT_TIMEOUT'),
      ), 10_000)),
    ]);
  }

  async function openAudio(state) {
    const socket = await openWebSocket(
      audioUrl, state.grant.audioCapability,
    );
    const opened = clock();
    state.audio = socket;
    const audioClaim = claim(state, 'audio');
    clientRecorder.audioOpen(audioClaim, opened);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(
        new Error('PHASE5_SOAK_AUDIO_READY_TIMEOUT'),
      ), 10_000);
      socket.on('message', (value, isBinary) => {
        if (!state.recording) return;
        try {
          const observed = clock();
          if (observed.atMonotonicMs > windowEnd) return;
          if (isBinary) clientRecorder.audioPcm(
            audioClaim, observed, Buffer.from(value),
          );
          else {
            const bytes = Buffer.from(value);
            clientRecorder.audioJsonFrame(audioClaim, observed, bytes);
            if (JSON.parse(bytes).type === 'audio.ready') {
              clearTimeout(timer); resolve();
            }
          }
        } catch (error) { terminal = true; reject(error); }
      });
    });
    socket.on('close', (code, reason) => {
      if (!state.recording) return;
      try {
        clientRecorder.audioClose(audioClaim, clock(), code || 1006,
          Buffer.from(reason).toString('utf8') || 'ABNORMAL_CLOSE');
      } catch { terminal = true; }
    });
    await ready;
  }

  await Promise.all(states.map(async (state) => {
    await openRuntime(state, state.grant.runtimeCapability, 1);
    await openAudio(state);
  }));

  async function handleInstruction(instruction) {
    if (terminal || !instruction || ![4, 5, 6, 8].includes(
      instruction.sequence,
    )) fail('PHASE5_SOAK_CLIENT_INSTRUCTION_INVALID');
    const state = states[3];
    if (instruction.sequence === 4 || instruction.sequence === 8) {
      if (typeof instruction.runtimeCapability !== 'string') {
        fail('PHASE5_SOAK_CLIENT_INSTRUCTION_INVALID');
      }
      await closePromise(state.runtime);
      await openRuntime(state, instruction.runtimeCapability,
        state.grant.runtimeGeneration + 1);
      return true;
    }
    const transport = state.audio?._socket;
    if (!transport || typeof transport.pause !== 'function'
        || typeof transport.resume !== 'function'
        || typeof transport.isPaused !== 'function') {
      fail('PHASE5_SOAK_SLOW_CLIENT_UNAVAILABLE');
    }
    const audioClaim = claim(state, 'audio');
    if (instruction.sequence === 5) {
      clientRecorder.audioPause(audioClaim, clock());
      transport.pause();
      if (!transport.isPaused()) fail('PHASE5_SOAK_SLOW_CLIENT_UNAVAILABLE');
    } else {
      clientRecorder.audioResume(audioClaim, clock());
      transport.resume();
      if (transport.isPaused()) fail('PHASE5_SOAK_SLOW_CLIENT_UNAVAILABLE');
    }
    return true;
  }

  function snapshotProbe(client, probeSeq) {
    if (terminal || !Number.isSafeInteger(client) || client < 1 || client > 4
        || !Number.isSafeInteger(probeSeq) || probeSeq < 1) {
      fail('PHASE5_SOAK_PROBE_INVALID');
    }
    const state = states[client - 1];
    if (state.pendingProbe !== null) fail('PHASE5_SOAK_PROBE_PENDING');
    const sent = clock();
    let resolveProbe;
    let rejectProbe;
    const result = new Promise((resolve, reject) => {
      resolveProbe = resolve; rejectProbe = reject;
    });
    state.pendingProbe = { probeSeq, resolve: resolveProbe, reject: rejectProbe };
    latencyRecorder.uiProbeSent({ client,
      connectionGeneration: state.grant.runtimeGeneration, probeSeq,
      sentAtMonotonicMs: sent.atMonotonicMs, sentAtUnixMs: sent.atUnixMs });
    state.runtime.send(JSON.stringify({
      type: 'command', protocolVersion: 1,
      commandId: `phase5-probe-${client}-${state.grant.runtimeGeneration}-${probeSeq}`,
      worldGeneration: state.worldGeneration, baseRevision: state.revision,
      name: 'snapshot.request', payload: {},
    }));
    return result;
  }

  function finishRecording() {
    for (const state of states) state.recording = false;
  }

  async function close() {
    finishRecording();
    await Promise.all(states.flatMap((state) => [state.runtime, state.audio]
      .filter(Boolean).map(async (socket) => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'SOAK_COMPLETE');
        await closePromise(socket);
      })));
  }

  return Object.freeze({ states, handleInstruction, snapshotProbe,
    finishRecording, close, get terminal() { return terminal; } });
}
