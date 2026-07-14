import { addBoid, addFlock, addObstacle, createWorld, eraseAt, injectEnergy, setHarmonicCenter, setInteraction, snapshotWorld, stepWorld } from './world.js';

export class SessionRecorder {
  constructor(world) { this.seed = world.seed; this.startedAt = world.time; this.events = []; }
  record(world, type, payload = {}) { this.events.push({ time: world.time - this.startedAt, type, payload: structuredClone(payload) }); }
  export() { return { schema: 1, seed: this.seed, events: structuredClone(this.events) }; }
}

export function replaySession(session, duration, step = 1 / 200) {
  const world = createWorld({ seed: session.seed });
  const events = [...session.events].sort((a, b) => a.time - b.time);
  let index = 0;
  while (world.time < duration - 1e-9) {
    while (index < events.length && events[index].time <= world.time + 1e-9) {
      const event = events[index++];
      if (event.type === 'interaction') setInteraction(world, event.payload);
      if (event.type === 'release') setInteraction(world, null);
      if (event.type === 'harmony') setHarmonicCenter(world, event.payload.note, event.payload.velocity);
      if (event.type === 'energy') injectEnergy(world, event.payload.amount);
      if (event.type === 'add-boid') addBoid(world, event.payload.flockId, event.payload.x, event.payload.y);
      if (event.type === 'add-flock') addFlock(world, event.payload.speciesId, event.payload.x, event.payload.y);
      if (event.type === 'add-obstacle') addObstacle(world, event.payload.x, event.payload.y, event.payload.radius);
      if (event.type === 'erase') eraseAt(world, event.payload.x, event.payload.y, event.payload.radius);
    }
    stepWorld(world, Math.min(step, duration - world.time));
  }
  return snapshotWorld(world);
}
