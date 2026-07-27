function wirePayload(record, split) {
  if (split) return record.payload;
  if (Buffer.isBuffer(record.payload)) return record.payload;
  if (Buffer.isBuffer(record.frame) && record.frame.length >= 32) return record.frame.subarray(32);
  throw new Error('LEGACY_PCM_RECORD_INVALID');
}

function parameterCommands(value) {
  const timbres = ['bass', 'pad', 'lead', 'pluck'];
  const commands = ['gain', 'rich', 'room', 'dirt']
    .filter((param) => Object.hasOwn(value, param))
    .map((param) => ({ type: 'continuous.set', row: value.voice, param, value: value[param] }));
  if (Object.hasOwn(value, 'timbre')) commands.push({ type: 'latent.set', row: value.voice,
    param: 'timbre', value: typeof value.timbre === 'string'
      ? (timbres.includes(value.timbre) ? timbres.indexOf(value.timbre) : 1)
      : Number.isInteger(value.timbre) && value.timbre >= 0 ? value.timbre : 1 });
  for (const [legacy, param] of [['timbreXY', 'timbre_xy'], ['timbreK', 'timbre_k'],
    ['timbrePCA', 'timbre_pca']]) {
    if (Object.hasOwn(value, legacy)) commands.push({ type: 'latent.set', row: value.voice,
      param, value: value[legacy] });
  }
  return commands;
}

export function createDecoderAdapter({ socket, session, audioOwner, planner,
  masterRing, splitRing, geometry, egressMs = 500 } = {}) {
  if (!socket || typeof socket.send !== 'function' || !session
      || typeof audioOwner?.owns !== 'function' || typeof planner?.enqueueControl !== 'function'
      || !masterRing || !splitRing || !geometry) throw new Error('DECODER_ADAPTER_DEPENDENCIES_REQUIRED');
  const ring = session.split ? splitRing : masterRing;
  const channels = session.split ? geometry.poolSize : 2;
  const capacity = Math.ceil((egressMs * geometry.sampleRate) / (1000 * geometry.blockFrames));
  let queue = [];
  let writing = false;
  let stopped = false;
  let unsubscribe = null;
  const totalCapacity = capacity + 4;

  function send(data, binary, done = () => {}) {
    try { socket.send(data, { binary }, done); } catch (error) { done(error); }
  }
  function drain() {
    if (stopped || writing || queue.length === 0) return;
    writing = true;
    const entry = queue.shift();
    send(entry.data, entry.binary, (error) => {
      writing = false;
      if (error) { stop(); socket.close?.(1011, 'LEGACY_SEND_FAILED'); return; }
      drain();
    });
  }
  function enqueueRecord(record) {
    const binaryCount = queue.filter((entry) => entry.binary).length + (writing ? 1 : 0);
    if (binaryCount >= capacity || queue.length + (writing ? 1 : 0) >= totalCapacity) {
      stop(); socket.close?.(1011, 'LEGACY_EGRESS_OVERFLOW'); return;
    }
    queue.push({ binary: true, data: wirePayload(record, session.split) });
    drain();
  }
  function enqueueJson(value) {
    if (queue.length + (writing ? 1 : 0) >= totalCapacity) {
      stop(); socket.close?.(1011, 'LEGACY_EGRESS_OVERFLOW'); return false;
    }
    queue.push({ binary: false, data: JSON.stringify(value) });
    drain();
    return true;
  }
  function start() {
    const attached = ring.attach((value) => {
      if (session.split) enqueueRecord(value);
      else if (value?.type === 'pcm.block') enqueueRecord(value.record);
    });
    unsubscribe = attached.unsubscribe;
    queue.push({ binary: false, data: JSON.stringify({ type: 'legacy.session',
      decoderSessionId: session.decoderSessionId, readOnly: true }) },
    { binary: false, data: JSON.stringify({ type: 'ready', protocolVersion: 1,
      modelId: session.backend?.id ?? 'backend-owned-runtime', backend: session.backend ?? null,
      sampleRate: geometry.sampleRate,
      blockSamples: geometry.blockFrames, samplesPerFrame: geometry.blockFrames,
      framesPerDecode: 1, poolSize: geometry.poolSize, channels,
      split: session.split, trackCount: session.split ? geometry.poolSize : 1,
      splitSupported: true, splitChannels: geometry.poolSize,
      controlSchemes: ['control', 'note'], timbres: ['bass', 'pad', 'lead', 'pluck'],
      serverSideMastering: false,
      pcmFormat: session.split ? 'f32-interleaved-tracks' : 'f32-interleaved-stereo' }) },
    ...attached.history.slice(-capacity).map((record) => ({ binary: true,
      data: wirePayload(record, session.split) })));
    drain();
  }
  function route(frame) {
    if (!audioOwner.owns(session.decoderSessionId)) {
      enqueueJson({ type: 'error', code: 'LEGACY_LEASE_REQUIRED',
        message: 'legacy decoder is read-only' });
      return Object.freeze({ accepted: false, code: 'LEGACY_LEASE_REQUIRED' });
    }
    let commands;
    if (frame?.type === 'note') commands = [...parameterCommands(frame),
      { type: 'note.on', row: frame.voice,
        midi: frame.midi, velocity: frame.velocity, durationSeconds: frame.durationSeconds }];
    else if (frame?.type === 'noteOff') commands = [{ type: 'note.off', row: frame.voice }];
    else if (frame?.type === 'control' && Array.isArray(frame.voices)) {
      commands = frame.voices.flatMap((voice) => {
        const values = parameterCommands(voice);
        if (voice.gate === true) values.push({ type: 'gate.on', row: voice.voice,
          midi: voice.midi, velocity: voice.velocity });
        else if (voice.gate === false) values.push({ type: 'gate.off', row: voice.voice });
        return values;
      });
    } else if (frame?.type === 'buffer') return Object.freeze({ accepted: true, code: 'ok' });
    else return Object.freeze({ accepted: false, code: 'LEGACY_FRAME_INVALID' });
    const result = planner.enqueueControl(commands);
    return Object.freeze({ accepted: result?.accepted === true,
      code: result?.accepted === true ? 'ok' : result?.reason ?? 'LEGACY_AUDIO_REJECTED' });
  }
  function stop() {
    if (stopped) return false;
    stopped = true; queue = []; unsubscribe?.(); unsubscribe = null;
    return true;
  }
  return Object.freeze({ start, stop, route, getStatus: () => Object.freeze({ stopped,
    writing, queued: queue.length, capacity }) });
}
