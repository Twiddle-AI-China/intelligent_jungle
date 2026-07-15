const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value)));

export const DEFAULT_ENGINE_CONFIG = Object.freeze({
  timbreRange: 1.25,
  latentStep: 0.2,
  attackSeconds: 0.06,
  releaseSeconds: 0.45,
});

export function createXYEngine(options = {}) {
  return {
    time: 0,
    x: clamp(options.x ?? 0.5),
    y: clamp(options.y ?? 0.5),
    pointerActive: false,
    relationState: Array(8).fill(0),
    heldNotes: new Map(),
    eternal: true,
    gate: true,
    gateSerial: 1,
    voiceAge: 0,
    velocity: 0.8,
    lastNote: 60,
    pitchSemitones: 0,
    config: { ...DEFAULT_ENGINE_CONFIG, ...(options.config ?? {}) },
  };
}

export function setXYTarget(engine, x, y, active = true) {
  engine.x = clamp(x);
  engine.y = clamp(y);
  engine.pointerActive = Boolean(active);
  return { x: engine.x, y: engine.y, active: engine.pointerActive };
}

export function releaseXYTarget(engine) {
  engine.pointerActive = false;
}

export function noteOn(engine, id, note = 60, velocity = 1) {
  engine.heldNotes.set(String(id), { note: Math.round(note), velocity: clamp(velocity) });
  engine.gate = true;
  engine.velocity = Math.max(...Array.from(engine.heldNotes.values(), (item) => item.velocity));
  engine.lastNote = Math.round(note);
  engine.pitchSemitones = clamp(Math.round(note) - 60, -12, 12);
  // The eternal carrier is already open. Keyboard gestures do not restart its age.
  return engine.gateSerial;
}

export function noteOff(engine, id) {
  engine.heldNotes.delete(String(id));
  engine.gate = true;
  if (engine.heldNotes.size > 0) {
    engine.velocity = Math.max(...Array.from(engine.heldNotes.values(), (item) => item.velocity));
    const latest = Array.from(engine.heldNotes.values()).at(-1);
    engine.lastNote = latest.note; engine.pitchSemitones = clamp(latest.note - 60, -12, 12);
  } else {
    engine.velocity = 0.8;
    engine.lastNote = 60;
    engine.pitchSemitones = 0;
  }
  return engine.gate;
}

export function setEngineControl(engine, key, value) {
  const ranges = {
    timbreRange: [0.25, 6],
    latentStep: [0.005, 0.5],
    attackSeconds: [0.001, 1],
    releaseSeconds: [0.005, 4],
  };
  if (!ranges[key]) return false;
  engine.config[key] = clamp(value, ...ranges[key]);
  return engine.config[key];
}

export function stepXYEngine(engine, dt) {
  const elapsed = Math.max(0, Number(dt));
  engine.time += elapsed;
  engine.voiceAge += elapsed;
  return engine;
}

export function snapshotXYEngine(engine) {
  return {
    time: Number(engine.time.toFixed(6)),
    x: Number(engine.x.toFixed(6)),
    y: Number(engine.y.toFixed(6)),
    pointerActive: engine.pointerActive,
    relationState: [...engine.relationState],
    eternal: engine.eternal,
    gate: engine.gate,
    gateSerial: engine.gateSerial,
    voiceAge: Number(engine.voiceAge.toFixed(6)),
    velocity: Number(engine.velocity.toFixed(6)),
    lastNote: engine.lastNote,
    pitchSemitones: engine.pitchSemitones,
    config: { ...engine.config },
  };
}
