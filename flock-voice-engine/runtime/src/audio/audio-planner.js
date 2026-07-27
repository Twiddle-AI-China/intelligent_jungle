const VOICE_ALIAS = Object.freeze({ melody: 'lead', texture: 'pluck' });
function inferSpecies(command) {
  return command.species ?? command.treeId ?? command.voice ?? null;
}
function resolveRow(command, rowVoices) {
  if (Number.isInteger(command.row)) return command.row;
  const species = inferSpecies(command);
  const voice = VOICE_ALIAS[species] ?? species;
  const rows = rowVoices.map((item, row) => item === voice ? row : -1).filter((row) => row >= 0);
  if (rows.length === 0) throw new Error('AUDIO_VOICE_UNAVAILABLE');
  return rows[Math.abs(Number(command.birdId) || 0) % rows.length];
}
function normalize(command, rowVoices, targetFrame, frameClock) {
  const value = structuredClone(command);
  if (value.type === 'note.release') value.type = 'note.off';
  if (value.type === 'latent.xy') return { type: 'latent.set', voice: VOICE_ALIAS[value.voice] ?? value.voice,
    param: 'timbre_xy', value: value.xy };
  if (value.type === 'latent.pca') return { type: 'latent.set', voice: VOICE_ALIAS[value.voice] ?? value.voice,
    param: 'timbre_pca', value: value.coeffs };
  if (['note.on', 'note.off', 'gate.on', 'gate.off'].includes(value.type)) {
    const row = resolveRow(value, rowVoices);
    if (value.type === 'note.off' || value.type === 'gate.off') return { type: value.type, row };
    const { treeId: _treeId, birdId: _birdId, species: _species, voice: _voice, ...rest } = value;
    return { ...rest, row };
  }
  if (value.type === 'preview.start') return { type: value.type,
    voice: VOICE_ALIAS[value.voice] ?? value.voice,
    expiresAtFrame: frameClock.addSeconds(targetFrame, 5).toString() };
  if (value.type === 'preview.allOff') return { type: value.type,
    ...(value.voice ? { voice: VOICE_ALIAS[value.voice] ?? value.voice } : {}) };
  if (value.voice) value.voice = VOICE_ALIAS[value.voice] ?? value.voice;
  return value;
}

export function createAudioPlanner({ clock, frameClock, enqueueBatch, getAudioState,
  audioEpoch = null, outboundCapacity = 256, onTransportFailure = null } = {}) {
  if (typeof clock?.now !== 'function' || typeof frameClock?.targetFrame !== 'function'
      || typeof enqueueBatch !== 'function' || typeof getAudioState !== 'function') {
    throw new Error('AUDIO_PLANNER_DEPENDENCIES_REQUIRED');
  }
  let epoch = audioEpoch;
  let commandSeq = 0;
  let paused = true;
  let pauseReason = 'WORKER_NOT_READY';
  let latestState = null;
  let degraded = false;
  let acceptedCommandSeq = 0;
  let appliedCommandSeq = 0;
  let transport = enqueueBatch;
  let transportDepth = () => 0;
  let rowVoices = [];
  let postReplacementBuffer = null;
  let recentBatches = [];
  function submit(commands, targetFrame = null) {
    if (!epoch) return { accepted: false, reason: 'AUDIO_EPOCH_MISSING' };
    commandSeq += 1;
    const frame = targetFrame ?? frameClock.targetFrame(Number(clock.now()) / 1000);
    const batch = { type: 'audio.command.batch', audioEpoch: epoch, commandSeq,
      targetFrame: frame.toString(), commands: commands.map((command) => (
        normalize(command, rowVoices, frame, frameClock)
      )) };
    const result = transport(batch);
    if (result?.accepted !== true) {
      const overflow = result?.reason === 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW';
      if (overflow && !degraded) onTransportFailure?.(result.reason);
      degraded ||= overflow;
      return { accepted: false, reason: result?.reason ?? 'AUDIO_ENQUEUE_REJECTED' };
    }
    recentBatches = [...recentBatches, { commandSeq,
      commands: batch.commands.map(({ type, row, voice }) => ({ type,
        ...(Number.isInteger(row) ? { row } : {}), ...(typeof voice === 'string' ? { voice } : {}) })) }]
      .slice(-32);
    return { accepted: true, reason: null, commandSeq };
  }
  function captureState() {
    try { latestState = getAudioState(); } catch { latestState = null; }
  }
  return Object.freeze({
    accept(commands) {
      if (!Array.isArray(commands)) throw new Error('AUDIO_COMMANDS_INVALID');
      if (paused) {
        captureState();
        if (postReplacementBuffer !== null) {
          if (postReplacementBuffer.length >= outboundCapacity) {
            if (!degraded) onTransportFailure?.('RUNTIME_AUDIO_OUTBOUND_OVERFLOW');
            degraded = true;
            return { accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW' };
          }
          postReplacementBuffer.push(structuredClone(commands));
        }
        return { accepted: true, reason: null, deferred: true };
      }
      return submit(commands);
    },
    enqueueControl(commands, targetFrame = null) { return submit(commands, targetFrame); },
    replace(state = getAudioState(), targetFrame = null) {
      latestState = structuredClone(state);
      const result = submit([{ type: 'state.replace', value: latestState }], targetFrame);
      return result;
    },
    replaceCurrentAndBufferFollowing(targetFrame = null) {
      const state = getAudioState();
      const result = this.replace(state, targetFrame);
      if (result.accepted === true) postReplacementBuffer = [];
      return { ...result, stateRevision: state?.stateRevision };
    },
    pauseWorldWrites(reason) { paused = true; pauseReason = reason; captureState(); },
    resumeWorldWrites() {
      if (degraded) return { accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW' };
      for (const commands of postReplacementBuffer ?? []) {
        const flushed = submit(commands);
        if (flushed.accepted !== true) return flushed;
      }
      postReplacementBuffer = null;
      paused = false; pauseReason = null;
      return { accepted: true, reason: null };
    },
    bindEpoch(next) { epoch = next; commandSeq = 0; degraded = false; recentBatches = []; },
    bindGeometry(next) {
      if (!Array.isArray(next?.rowVoices) || next.rowVoices.length === 0) {
        throw new Error('AUDIO_GEOMETRY_REQUIRED');
      }
      rowVoices = [...next.rowVoices];
    },
    replaceFrameMap(next) { frameClock.replace(next); },
    bindTransport(next, getDepth = () => 0) {
      if (typeof next !== 'function' || typeof getDepth !== 'function') {
        throw new Error('AUDIO_TRANSPORT_INVALID');
      }
      transport = next;
      transportDepth = getDepth;
    },
    noteAccepted(seq) { acceptedCommandSeq = Math.max(acceptedCommandSeq, seq); },
    noteApplied(seq) { appliedCommandSeq = Math.max(appliedCommandSeq, seq); },
    getStatus() { return Object.freeze({ paused, pauseReason, audioEpoch: epoch, commandSeq,
      acceptedCommandSeq, appliedCommandSeq, outboundQueueDepth: transportDepth(), degraded,
      hasDeferredState: latestState !== null,
      deferredBatchCount: postReplacementBuffer?.length ?? 0,
      recentBatches: structuredClone(recentBatches) }); },
  });
}
