import { createXYEngine, noteOff, noteOn, releaseXYTarget, setEngineControl, setXYTarget, snapshotXYEngine, stepXYEngine } from './xy-engine.js';

export class SessionRecorder {
  constructor(engine) { this.startedAt = engine.time; this.events = []; }
  record(engine, type, payload = {}) { this.events.push({ time: engine.time - this.startedAt, type, payload: structuredClone(payload) }); }
  export() { return { schema: 2, engine: 'xy-latent', events: structuredClone(this.events) }; }
}

export function replaySession(session, duration, step = 1 / 200) {
  const engine = createXYEngine();
  const events = [...session.events].sort((a, b) => a.time - b.time);
  let index = 0;
  while (engine.time < duration - 1e-9) {
    while (index < events.length && events[index].time <= engine.time + 1e-9) applyEvent(engine, events[index++]);
    stepXYEngine(engine, Math.min(step, duration - engine.time));
  }
  while (index < events.length && events[index].time <= duration + 1e-9) applyEvent(engine, events[index++]);
  return snapshotXYEngine(engine);
}

function applyEvent(engine, event) {
  const { type, payload } = event;
  if (type === 'xy') setXYTarget(engine, payload.x, payload.y, payload.active);
  if (type === 'xy-release') releaseXYTarget(engine);
  if (type === 'relations') engine.relationState = payload.values.map(Number).slice(0, 8);
  if (type === 'note-on') noteOn(engine, payload.id, payload.note, payload.velocity);
  if (type === 'note-off') noteOff(engine, payload.id);
  if (type === 'control') setEngineControl(engine, payload.key, payload.value);
}
