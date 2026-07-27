import { assertExactWorkerIdentity } from './worker-identity.js';
import { assertExactAudioGeometry, decodeU64Decimal } from './worker-protocol.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PUBLIC_STATUS_KEYS = new Set(['runtimeOwner', 'audioOwner', 'workerReady', 'recovering',
  'degraded', 'degradedReason', 'audio']);

export function createWorkerSupervisor({ connector, trustedReleaseManifest, planner, getAudioState,
  masterPcmPublisher, splitPcmSink, publicStatusStore, clock = { now: () => Date.now() },
  replaceTimeoutMs = 5000, primeTimeoutMs = 5000,
  getAudioControlState = () => ({ audioOwner: 'world', transitioning: false }),
  legacyAccess = { suspendWrites() {}, rejectWrites() {}, resumeExactGeneration: () => true },
  delay = sleep, getRecoveryCommands = () => [] } = {}) {
  if (typeof connector?.connect !== 'function' || typeof trustedReleaseManifest !== 'function'
      || typeof planner?.pauseWorldWrites !== 'function' || typeof getAudioState !== 'function'
      || typeof masterPcmPublisher?.publish !== 'function' || typeof splitPcmSink?.publish !== 'function'
      || typeof publicStatusStore?.update !== 'function'
      || typeof publicStatusStore?.guardedUpdate !== 'function'
      || typeof getAudioControlState !== 'function'
      || typeof legacyAccess?.suspendWrites !== 'function'
      || typeof legacyAccess?.rejectWrites !== 'function'
      || typeof legacyAccess?.resumeExactGeneration !== 'function') {
    throw new Error('WORKER_SUPERVISOR_DEPENDENCIES_REQUIRED');
  }
  let connection = null;
  let stopped = false;
  let rebuilding = null;
  let status = { workerReady: false, recovering: true, restartCount: 0, reason: 'STARTING' };
  let unsubscribe = null;
  let connectionGeneration = 0;
  let activeGeometry = null;
  let cancelBackoff = null;
  let pendingReady = null;

  async function update(patch) {
    status = { ...status, ...patch };
    const publicPatch = Object.fromEntries(Object.entries(patch)
      .filter(([key]) => PUBLIC_STATUS_KEYS.has(key)));
    if (Object.keys(publicPatch).length > 0) await publicStatusStore.update(publicPatch);
  }
  function consume(message) {
    if (message?.type === 'pcm.master' || message?.type === 'pcm.split') {
      const expectedChannels = message.type === 'pcm.master' ? 2 : activeGeometry?.poolSize;
      if (!activeGeometry || message.frameCount !== activeGeometry.blockFrames
          || message.channels !== expectedChannels || message.format !== 1) {
        throw new Error('AUDIO_PCM_GEOMETRY_MISMATCH');
      } else if (message.type === 'pcm.master') masterPcmPublisher.publish(message);
      else splitPcmSink.publish(message);
    }
    else if (message?.type === 'command.accepted') planner.noteAccepted?.(message.commandSeq);
    else if (message?.type === 'command.rejected' && message.rebuildRequired === true) {
      throw new Error(message.code ?? 'WORKER_REBUILD_REQUIRED');
    }
    else if (message?.type === 'audio.state.applied') planner.noteApplied?.(message.appliedCommandSeq);
    else if (message?.type === 'audio.telemetry') {
      const blockDurationMs = Number(message.blockDurationMs);
      status = { ...status, telemetry: { workerReady: message.workerReady, recovering: message.recovering,
        pcmHeadroomBlocks: message.pcmHeadroomBlocks, queueDepth: message.queueDepth,
        renderP95Ms: message.renderP95Ms, renderP99Ms: message.renderP99Ms, blockDurationMs,
        recentUnderruns: message.recentUnderruns,
        appliedCommandSeq: message.appliedCommandSeq,
        rowMasterContributionPeakAbs: Array.isArray(message.rowMasterContributionPeakAbs)
          ? [...message.rowMasterContributionPeakAbs] : null,
        unifiedMemoryFreeBytes: Number(BigInt(message.unifiedMemoryFreeBytes)),
        receivedAtMs: Number(clock.now()), degraded: message.degraded } };
    }
  }
  function assertActive(generation) {
    if (stopped || generation !== connectionGeneration) throw new Error('WORKER_SUPERVISOR_CANCELLED');
  }
  async function rebuildAttempt(reason = 'REBUILD') {
    unsubscribe?.(); connection?.close?.();
    masterPcmPublisher.hold?.();
    splitPcmSink.reset?.();
    const generation = ++connectionGeneration;
    connection = await connector.connect();
    assertActive(generation);
    const activeConnection = connection;
    planner.bindTransport?.((batch) => activeConnection.enqueueBatch(batch),
      () => activeConnection.outboundQueueDepth ?? 0);
    const reported = await connection.readWorkerHello();
    assertActive(generation);
    const release = await trustedReleaseManifest();
    assertActive(generation);
    await update({ expectedIdentity: release.workerIdentity, reportedIdentity: reported.identity,
      mismatchReason: null });
    try {
      assertExactWorkerIdentity(release.workerIdentity, reported.identity);
    } catch (error) {
      await update({ mismatchReason: error.message, degraded: true,
        degradedReason: error.message, reason: error.message });
      throw error;
    }
    connection.acceptIdentity(release.workerIdentity);
    const ready = await connection.readWorkerReady();
    assertActive(generation);
    try {
      assertExactAudioGeometry(release.geometry, ready.geometry);
    } catch (error) {
      await update({ mismatchReason: error.message, degraded: true,
        degradedReason: error.message, reason: error.message });
      throw error;
    }
    activeGeometry = ready.geometry;
    planner.bindEpoch?.(ready.audioEpoch);
    planner.bindGeometry?.(ready.geometry);
    unsubscribe = connection.subscribe((message) => {
      if (generation !== connectionGeneration) return;
      if (message?.type === 'worker.connection.closed') {
        connectionGeneration += 1;
        if (!stopped) triggerRecovery('WORKER_CONNECTION_CLOSED', true).catch(() => {});
        return;
      }
      try { consume(message); } catch (error) {
        connectionGeneration += 1;
        if (!stopped) triggerRecovery(error?.message ?? 'WORKER_PROTOCOL_FAILED', true).catch(() => {});
      }
    });
    const replacement = await getAudioState(ready);
    assertActive(generation);
    if (!Number.isSafeInteger(replacement?.stateRevision) || replacement.stateRevision < 0) {
      throw new Error('AUDIO_STATE_REVISION_INVALID');
    }
    planner.replaceFrameMap?.({ worldTimeSeconds: replacement.frameMap.worldTimeSeconds,
      renderFrame: ready.renderFrame });
    const result = planner.replace(replacement, ready.renderFrame);
    if (result?.accepted !== true) throw new Error(result?.reason ?? 'AUDIO_REPLACE_REJECTED');
    const applied = await connection.next((value) => value?.type === 'audio.state.applied'
      && value.audioEpoch === ready.audioEpoch && value.appliedCommandSeq === result.commandSeq
      && value.stateRevision === replacement.stateRevision, replaceTimeoutMs);
    assertActive(generation);
    let appliedFrame = decodeU64Decimal(applied.renderFrame);
    const recoveryCommands = await getRecoveryCommands(ready, replacement);
    if (!Array.isArray(recoveryCommands)) throw new Error('AUDIO_RECOVERY_COMMANDS_INVALID');
    if (recoveryCommands.length > 0) throw new Error('AUDIO_RECOVERY_MUST_USE_FINAL_REPLACEMENT');
    const barrier = planner.replaceCurrentAndBufferFollowing(appliedFrame);
    if (barrier?.accepted !== true || !Number.isSafeInteger(barrier.stateRevision)) {
      throw new Error(barrier?.reason ?? 'AUDIO_FINAL_REPLACEMENT_REJECTED');
    }
    const barrierApplied = await connection.next((value) => value?.type === 'audio.state.applied'
      && value.audioEpoch === ready.audioEpoch && value.appliedCommandSeq === barrier.commandSeq
      && value.stateRevision === barrier.stateRevision, replaceTimeoutMs);
    assertActive(generation);
    appliedFrame = decodeU64Decimal(barrierApplied.renderFrame);
    const recoveredStream = { audioEpoch: ready.audioEpoch, minStartFrame: appliedFrame };
    if (masterPcmPublisher.stageStream) masterPcmPublisher.stageStream(recoveredStream);
    else masterPcmPublisher.beginStream?.(recoveredStream);
    if (masterPcmPublisher.waitForPostAppliedPrime) {
      let timer;
      try {
        await Promise.race([
          masterPcmPublisher.waitForPostAppliedPrime(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('AUDIO_PCM_PRIME_TIMEOUT')), primeTimeoutMs);
          }),
        ]);
      } catch (error) {
        masterPcmPublisher.hold?.();
        throw error;
      } finally { clearTimeout(timer); }
    }
    assertActive(generation);
    const readyPatch = { workerReady: true, recovering: false, degraded: false, degradedReason: null,
      mismatchReason: null, reason: null,
      audio: { audioEpoch: ready.audioEpoch, manifestGeometrySha256: release.manifestGeometrySha256,
        sampleRate: ready.geometry.sampleRate, blockFrames: ready.geometry.blockFrames,
        channels: 2, format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32 } };
    const publicReadyPatch = Object.fromEntries(Object.entries(readyPatch)
      .filter(([key]) => PUBLIC_STATUS_KEYS.has(key)));
    const controlState = getAudioControlState();
    if (controlState?.transitioning === true
        || (controlState?.publicAudioOwner
          && controlState.publicAudioOwner !== controlState.audioOwner)) {
      pendingReady = { generation, publicReadyPatch, readyPatch };
      status = { ...status, ...readyPatch, recovering: true };
      assertActive(generation);
      return ready;
    }
    const resumeWorld = controlState?.audioOwner === 'world';
    const readyCommit = await publicStatusStore.guardedUpdate(publicReadyPatch,
      () => {
        const latest = getAudioControlState();
        return !stopped && generation === connectionGeneration
          && planner.getStatus?.().degraded !== true
          && latest?.transitioning !== true
          && latest?.audioOwner === controlState.audioOwner
          && (!latest?.publicAudioOwner || latest.publicAudioOwner === latest.audioOwner)
          && (resumeWorld || latest?.decoderSessionId === controlState.decoderSessionId);
      },
      () => {
        if (resumeWorld) {
          legacyAccess.rejectWrites('worker-recovery-world');
          return planner.resumeWorldWrites();
        }
        return { accepted: legacyAccess.resumeExactGeneration(controlState.decoderSessionId),
          reason: 'LEGACY_GENERATION_CHANGED' };
      },
      () => masterPcmPublisher.commitStagedStream?.());
    if (readyCommit?.updated !== true) {
      throw new Error(readyCommit?.result?.reason ?? 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW');
    }
    status = { ...status, ...readyPatch };
    pendingReady = null;
    assertActive(generation);
    return ready;
  }
  async function recoveryLoop(initialReason, delayFirst) {
    let reason = initialReason;
    planner.pauseWorldWrites(reason);
    legacyAccess.suspendWrites(reason);
    pendingReady = null;
    await update({ workerReady: false, recovering: true, degraded: true,
      degradedReason: reason, reason });
    let shouldDelay = delayFirst;
    while (!stopped) {
      if (shouldDelay) {
        const restartCount = status.restartCount + 1;
        await update({ restartCount, workerReady: false, recovering: true, reason });
        const waitMs = Math.min(10_000, 1000 * (2 ** Math.min(restartCount - 1, 4)));
        if (delay === sleep) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => { cancelBackoff = null; resolve(); }, waitMs);
            cancelBackoff = () => { clearTimeout(timer); cancelBackoff = null; resolve(); };
          });
        } else {
          await Promise.race([delay(waitMs), new Promise((resolve) => { cancelBackoff = resolve; })]);
          cancelBackoff = null;
        }
        if (stopped) break;
      }
      try {
        return await rebuildAttempt(reason);
      } catch (error) {
        if (stopped) break;
        reason = error?.message ?? 'WORKER_REBUILD_FAILED';
        await update({ workerReady: false, recovering: true, degraded: true,
          degradedReason: reason, reason });
        shouldDelay = true;
      }
    }
    throw new Error('WORKER_SUPERVISOR_STOPPED');
  }
  function triggerRecovery(reason, delayFirst) {
    if (stopped) return Promise.reject(new Error('WORKER_SUPERVISOR_STOPPED'));
    if (rebuilding) return rebuilding;
    rebuilding = recoveryLoop(reason, delayFirst).finally(() => { rebuilding = null; });
    return rebuilding;
  }
  function restart(reason) {
    return triggerRecovery(reason, true);
  }
  async function applyBarrierControl(commands, timeoutMs = replaceTimeoutMs) {
    if (rebuilding) await rebuilding;
    if (!status.workerReady || !connection || rebuilding) throw new Error('AUDIO_WORKER_NOT_READY');
    const generation = connectionGeneration;
    const result = planner.enqueueControl(commands);
    if (result?.accepted !== true) throw new Error(result?.reason ?? 'AUDIO_CONTROL_REJECTED');
    const accepted = connection.next((value) => value?.type === 'command.accepted'
      && value.audioEpoch === planner.getStatus().audioEpoch
      && value.commandSeq === result.commandSeq, timeoutMs);
    const applied = connection.next((value) => value?.type === 'audio.telemetry'
      && value.appliedCommandSeq >= result.commandSeq, timeoutMs);
    await accepted; await applied; assertActive(generation);
    const recovery = pendingReady?.generation === generation ? pendingReady : null;
    return Object.freeze({ accepted: true, commandSeq: result.commandSeq,
      readyPatch: recovery?.publicReadyPatch ?? null,
      commitStream: recovery && masterPcmPublisher.commitStagedStream
        ? () => masterPcmPublisher.commitStagedStream() : null,
      validate: () => assertActive(generation),
      commitReady() { assertActive(generation);
        if (pendingReady === recovery && recovery) {
          status = { ...status, ...recovery.readyPatch }; pendingReady = null;
        } },
    });
  }
  async function replaceOwnerWorld(timeoutMs = replaceTimeoutMs) {
    if (rebuilding) await rebuilding;
    if (!status.workerReady || !connection || rebuilding) throw new Error('AUDIO_WORKER_NOT_READY');
    const generation = connectionGeneration;
    const result = planner.replaceCurrentAndBufferFollowing();
    if (result?.accepted !== true) throw new Error(result?.reason ?? 'AUDIO_REPLACE_REJECTED');
    const applied = await connection.next((value) => value?.type === 'audio.state.applied'
      && value.audioEpoch === planner.getStatus().audioEpoch
      && value.appliedCommandSeq === result.commandSeq
      && value.stateRevision === result.stateRevision, timeoutMs);
    assertActive(generation);
    const appliedFrame = decodeU64Decimal(applied.renderFrame);
    masterPcmPublisher.hold?.();
    const stream = { audioEpoch: planner.getStatus().audioEpoch, minStartFrame: appliedFrame };
    if (masterPcmPublisher.stageStream) masterPcmPublisher.stageStream(stream);
    else masterPcmPublisher.beginStream?.(stream);
    if (masterPcmPublisher.waitForPostAppliedPrime) {
      let timer;
      try {
        await Promise.race([
          masterPcmPublisher.waitForPostAppliedPrime(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('AUDIO_PCM_PRIME_TIMEOUT')), primeTimeoutMs);
          }),
        ]);
      } catch (error) {
        masterPcmPublisher.hold?.();
        throw error;
      } finally { clearTimeout(timer); }
    }
    assertActive(generation);
    const recovery = pendingReady?.generation === generation ? pendingReady : null;
    return Object.freeze({ applied: true, renderFrame: appliedFrame,
      readyPatch: recovery?.publicReadyPatch ?? null,
      validate: () => assertActive(generation),
      commitReady() { assertActive(generation);
        if (pendingReady === recovery && recovery) {
          status = { ...status, ...recovery.readyPatch }; pendingReady = null;
        } },
      commitStream: masterPcmPublisher.commitStagedStream
        ? () => masterPcmPublisher.commitStagedStream() : null });
  }
  return Object.freeze({
    start: () => triggerRecovery('STARTING', false),
    stop() { stopped = true; connectionGeneration += 1; activeGeometry = null; pendingReady = null;
      cancelBackoff?.();
      unsubscribe?.(); connection?.close?.(); planner.pauseWorldWrites('STOPPED');
      return update({ workerReady: false, recovering: false, degraded: true,
        degradedReason: 'STOPPED', reason: 'STOPPED' }); },
    restart, rebuildStream: restart,
    replaceCurrentWorldState: () => triggerRecovery('STATE_REPLACE', false),
    barrierControl: Object.freeze({ apply: applyBarrierControl, replaceWorld: replaceOwnerWorld }),
    publishStreamDiscontinuity: (reason) => masterPcmPublisher.discontinuity?.(reason),
    waitForReady: async () => { if (status.workerReady) return status; await rebuilding; return status; },
    getStatus: () => Object.freeze({ ...structuredClone(status),
      commandAudit: structuredClone(planner.getStatus?.().recentBatches ?? []) }),
    getAdmissionTelemetry() {
      if (!status.telemetry) return null;
      return Object.freeze({ ...structuredClone(status.telemetry), workerReady: status.workerReady,
        recovering: status.recovering, degraded: status.degraded || status.telemetry.degraded });
    },
  });
}
