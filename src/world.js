export const TAU = Math.PI * 2;
export const FIXED_DT = 1 / 200;
export const PERCEPTUAL_DIMENSIONS = ['brightness', 'roughness', 'noisiness', 'harmonicity', 'transientness', 'density'];

export const DEFAULT_CONFIG = Object.freeze({
  count: 6,
  tempo: 82,
  contextCoupling: 0.04,
  meterCoupling: 0.02,
  formationCohesion: 0.09,
  commonMotion: 0.54,
  identitySpring: 0.028,
  conflictThreshold: 0.56,
  recoverySeconds: 22,
});

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const wrap01 = (value) => ((value % 1) + 1) % 1;
const shortestPhase = (target, source) => ((target - source + 1.5) % 1) - 0.5;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

export function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roleFor(id) {
  return ['bass', 'support', 'ornament'][id % 3];
}

function rolePitch(role, id) {
  if (role === 'bass') return id % 2 ? 7 : 0;
  if (role === 'support') return id % 2 ? 3 : 5;
  return id % 2 ? 9 : 10;
}

export function createWorld(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const seed = options.seed ?? 0xc05a05;
  const random = mulberry32(seed);
  const objects = Array.from({ length: config.count }, (_, id) => {
    const role = roleFor(id);
    const anchor = [
      0.18 + (id / Math.max(1, config.count - 1)) * 0.64,
      0.18 + ((id * 0.37) % 0.66),
      role === 'ornament' ? 0.62 : 0.2 + random() * 0.25,
      role === 'bass' ? 0.72 : 0.38 + random() * 0.3,
      role === 'support' ? 0.24 : 0.48 + random() * 0.3,
      0.26 + random() * 0.38,
    ].map((value) => clamp(value, 0.06, 0.94));
    const velocity = anchor.map(() => 0);
    return {
      id,
      role,
      identityAnchor: anchor,
      perceptualPosition: [...anchor],
      perceptualVelocity: velocity,
      naturalRate: 0.88 + random() * 0.24,
      phase: wrap01(id / config.count + random() * 0.08),
      energy: 0.34 + random() * 0.28,
      energyVelocity: 0,
      pitchClass: rolePitch(role, id),
      pitchRegister: role === 'bass' ? -1 : role === 'ornament' ? 1 : 0,
      pan: -0.78 + (id / Math.max(1, config.count - 1)) * 1.56,
      panAnchor: -0.78 + (id / Math.max(1, config.count - 1)) * 1.56,
      panVelocity: 0,
      pulse: 0,
      niche: { hold: 0, cooldown: 0, conflictSeconds: 0, action: null, decisions: 0 },
      x: anchor[0], y: anchor[1], vx: velocity[0], vy: velocity[1], brightness: anchor[0],
    };
  });
  return {
    schema: 3,
    seed,
    config,
    objects,
    tempo: config.tempo,
    harmonicCenter: 0,
    harmonicField: [1, 0, 0.18, 0.12, 0, 0.15, 0, 0.35, 0, 0.12, 0.08, 0],
    temperature: 0,
    time: 0,
    accumulator: 0,
    lastBar: 0,
    interaction: null,
    random,
    metrics: { phaseCoherence: 0, trendAgreement: 0, collectiveSpeed: 0, trendActive: false, maskingCost: 0, identityDrift: 0, identitySpread: 0, decisionRate: 0, context: 0, trend: 0, clarity: 0 },
  };
}

function perceptualDistance(a, b) {
  let sum = 0;
  for (let d = 0; d < a.length; d += 1) sum += (a[d] - b[d]) ** 2;
  return Math.sqrt(sum / a.length);
}

function affinity(a, b) {
  return Math.exp(-perceptualDistance(a.perceptualPosition, b.perceptualPosition) * 2.4);
}

function localWeight(object, interaction) {
  if (!interaction) return 0;
  const dx = object.perceptualPosition[0] - (interaction.x ?? 0.5);
  const dy = object.perceptualPosition[1] - (interaction.y ?? 0.5);
  return Math.exp(-(dx * dx + dy * dy) / 0.12);
}

function cohesionPhase(world, objects, object, dt, gather) {
  let phaseForce = 0;
  let weights = 0;
  for (const other of objects) {
    if (other.id === object.id) continue;
    const weight = affinity(object, other);
    phaseForce += weight * Math.sin(TAU * shortestPhase(other.phase, object.phase));
    weights += weight;
  }
  const meterPhase = wrap01(world.time * world.tempo / 60 / 4);
  const force = (world.config.contextCoupling * (1 + gather * 1.4) * phaseForce / Math.max(weights, 1e-6))
    + world.config.meterCoupling * (1 + gather) * Math.sin(TAU * shortestPhase(meterPhase, object.phase));
  return clamp(force, -1.2, 1.2) * dt;
}

function choosePitch(world, object) {
  const roleOffsets = object.role === 'bass' ? [0, 7] : object.role === 'support' ? [3, 5, 7] : [2, 9, 10];
  let best = roleOffsets[0];
  let bestScore = -Infinity;
  for (const offset of roleOffsets) {
    const pitch = (world.harmonicCenter + offset) % 12;
    const score = world.harmonicField[pitch] + Math.sin((object.id + 1) * (pitch + 3) * 12.9898) * 0.015;
    if (score > bestScore) { best = pitch; bestScore = score; }
  }
  object.pitchClass = best;
}

function boidsMotion(world, objects, previousObject, object, dt, guide, disturbance, separation) {
  const position = previousObject.perceptualPosition;
  const velocity = previousObject.perceptualVelocity;
  const nextVelocity = object.perceptualVelocity;
  const neighborVelocity = Array(velocity.length).fill(0);
  const neighborOffset = Array(velocity.length).fill(0);
  let weights = 0;
  for (const other of objects) {
    if (other.id === previousObject.id) continue;
    const weight = affinity(previousObject, other);
    for (let d = 0; d < velocity.length; d += 1) {
      const roleScale = d === 1 && previousObject.role === 'ornament' ? -0.35 : 0.72 + ((previousObject.id + d) % 3) * 0.12;
      neighborVelocity[d] += other.perceptualVelocity[d] * weight * roleScale;
      neighborOffset[d] += (other.perceptualPosition[d] - other.identityAnchor[d]) * weight;
    }
    weights += weight;
  }
  const neighborSpeed = Math.sqrt(neighborVelocity.reduce((sum, value) => sum + (value / Math.max(weights, 1e-6)) ** 2, 0) / velocity.length);
  for (let d = 0; d < velocity.length; d += 1) {
    const aligned = neighborSpeed > 0.0025 ? neighborVelocity[d] / Math.max(weights, 1e-6) : 0;
    const formationTarget = previousObject.identityAnchor[d] + neighborOffset[d] / Math.max(weights, 1e-6);
    const userForce = d === 0 ? guide.dx : d === 1 ? guide.dy : (guide.dx - guide.dy) * 0.18;
    const deterministicNoise = Math.sin((world.time * 37 + previousObject.id * 17 + d * 11) * 1.618) * disturbance * 0.018;
    nextVelocity[d] = velocity[d];
    nextVelocity[d] += (aligned - velocity[d]) * world.config.commonMotion * dt;
    nextVelocity[d] += (formationTarget - position[d]) * world.config.formationCohesion * dt;
    nextVelocity[d] += userForce * dt * 0.42 + deterministicNoise * dt;
    nextVelocity[d] += (previousObject.identityAnchor[d] - position[d]) * world.config.identitySpring * dt;
    if (d === 0) nextVelocity[d] += separation.brightness * dt;
    nextVelocity[d] *= Math.pow(neighborSpeed > 0.0025 || Math.abs(userForce) > 1e-6 ? 0.992 : 0.978, dt * 200);
    nextVelocity[d] = clamp(nextVelocity[d], -0.16, 0.16);
    object.perceptualPosition[d] = clamp(position[d] + nextVelocity[d] * dt, 0.04, 0.96);
  }
}

function conflict(a, b) {
  const registerOverlap = Math.max(0, 1 - Math.abs((a.pitchRegister * 12 + a.pitchClass) - (b.pitchRegister * 12 + b.pitchClass)) / 12);
  const spectralOverlap = Math.max(0, 1 - Math.abs(a.perceptualPosition[0] - b.perceptualPosition[0]) * 2.2);
  const onsetOverlap = Math.max(0, 1 - Math.abs(shortestPhase(a.phase, b.phase)) * 7);
  const panOverlap = Math.max(0, 1 - Math.abs(a.pan - b.pan) * 1.5);
  return registerOverlap * 0.34 + spectralOverlap * 0.3 + onsetOverlap * 0.2 + panOverlap * 0.16;
}

function separationForces(world, objects, scatter, dt) {
  const forces = objects.map(() => ({ brightness: 0, pan: 0, phaseRate: 0, maxConflict: 0, partner: -1 }));
  const threshold = world.config.conflictThreshold - scatter * 0.16;
  for (let i = 0; i < objects.length; i += 1) for (let j = i + 1; j < objects.length; j += 1) {
    const amount = conflict(objects[i], objects[j]);
    if (amount <= threshold) continue;
    const pressure = (amount - threshold) * (0.7 + scatter * 0.8);
    const brightnessDirection = Math.abs(objects[i].perceptualPosition[0] - objects[j].perceptualPosition[0]) > 1e-4
      ? Math.sign(objects[i].perceptualPosition[0] - objects[j].perceptualPosition[0]) : (objects[i].id < objects[j].id ? -1 : 1);
    const panDirection = Math.abs(objects[i].pan - objects[j].pan) > 1e-4
      ? Math.sign(objects[i].pan - objects[j].pan) : (objects[i].id < objects[j].id ? -1 : 1);
    const phaseDirection = shortestPhase(objects[i].phase, objects[j].phase) >= 0 ? 1 : -1;
    forces[i].brightness += brightnessDirection * pressure * 0.16;
    forces[j].brightness -= brightnessDirection * pressure * 0.16;
    forces[i].pan += panDirection * pressure * 0.42;
    forces[j].pan -= panDirection * pressure * 0.42;
    forces[i].phaseRate += phaseDirection * pressure * 0.018;
    forces[j].phaseRate -= phaseDirection * pressure * 0.018;
    for (const index of [i, j]) if (amount > forces[index].maxConflict) {
      forces[index].maxConflict = amount;
      forces[index].partner = index === i ? j : i;
    }
  }
  for (let i = 0; i < objects.length; i += 1) {
    const niche = objects[i].niche;
    niche.conflictSeconds = forces[i].maxConflict > threshold
      ? niche.conflictSeconds + dt : Math.max(0, niche.conflictSeconds - dt * 0.5);
  }
  return forces;
}

function resolvePersistentConflicts(world, objects, forces, scatter) {
  const barSeconds = 240 / world.tempo;
  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i];
    const partner = forces[i].partner >= 0 ? objects[forces[i].partner] : null;
    if (!partner || object.niche.conflictSeconds < 60 / world.tempo || object.niche.cooldown > 0 || object.niche.hold > 0) continue;
    const mover = object.niche.decisions < partner.niche.decisions
      || (object.niche.decisions === partner.niche.decisions && object.id < partner.id) ? object : partner;
    if (mover !== object) continue;
    const pitch = mover.pitchRegister * 12 + mover.pitchClass;
    const otherPitch = partner.pitchRegister * 12 + partner.pitchClass;
    const direction = pitch === otherPitch ? (mover.role === 'bass' ? -1 : 1) : Math.sign(pitch - otherPitch);
    mover.pitchRegister = clamp(mover.pitchRegister + direction, -2, 2);
    mover.niche.action = 'register';
    mover.niche.hold = barSeconds * (1 + ((mover.id + world.seed) & 1));
    mover.niche.cooldown = barSeconds * 2;
    mover.niche.conflictSeconds = 0;
    mover.niche.decisions += 1;
  }
}

function fixedStep(world, dt) {
  const interaction = world.interaction;
  const strength = interaction?.strength ?? 0;
  const gather = interaction?.mode === 'gather' ? strength : 0;
  const scatter = interaction?.mode === 'scatter' ? strength : 0;
  const disturbance = interaction?.mode === 'disturb' ? strength : 0;
  world.temperature += ((disturbance > 0 ? clamp(disturbance, 0, 1.5) : 0) - world.temperature) * dt / (disturbance > 0 ? 0.18 : world.config.recoverySeconds);
  for (let p = 0; p < 12; p += 1) world.harmonicField[p] *= Math.pow(gather > 0 ? 0.99996 : 0.99982, dt * 200);

  const previous = world.objects.map((object) => ({
    ...object,
    identityAnchor: [...object.identityAnchor],
    perceptualPosition: [...object.perceptualPosition],
    perceptualVelocity: [...object.perceptualVelocity],
    niche: { ...object.niche },
  }));
  const separation = separationForces(world, previous, scatter, dt);
  for (let index = 0; index < world.objects.length; index += 1) {
    const object = world.objects[index];
    const before = previous[index];
    const influence = localWeight(before, interaction);
    const localGather = gather * influence;
    const guide = interaction?.mode === 'guide'
      ? { dx: (interaction.dx ?? 0) * influence, dy: (interaction.dy ?? 0) * influence }
      : { dx: 0, dy: 0 };
    const previousPhase = before.phase;
    const natural = world.tempo / 60 / 4 * before.naturalRate * (1 + world.temperature * Math.sin(before.id * 8.31 + world.time * 3.7) * 0.12);
    object.phase = wrap01(before.phase + (natural + separation[index].phaseRate) * dt + cohesionPhase(world, previous, before, dt, localGather));
    object.pulse = object.phase < previousPhase ? 1 : Math.max(0, object.pulse - dt * 3.5);
    if (object.phase < previousPhase) choosePitch(world, object);
    boidsMotion(world, previous, before, object, dt, guide, world.temperature, separation[index]);
    if (interaction?.mode === 'energize') object.energyVelocity += strength * influence * dt * 0.28;
    object.energyVelocity += (0.48 - before.energy) * dt * 0.035;
    object.energyVelocity *= Math.pow(0.985, dt * 200);
    object.energy = clamp(before.energy + object.energyVelocity * dt, 0.12, 0.94);
    object.panVelocity = before.panVelocity + separation[index].pan * dt;
    object.panVelocity += (before.panAnchor - before.pan) * 0.015 * dt;
    object.panVelocity *= Math.pow(0.96, dt * 200);
    object.pan = clamp(before.pan + object.panVelocity * dt, -0.95, 0.95);
    object.niche.conflictSeconds = before.niche.conflictSeconds;
    object.niche.hold = Math.max(0, before.niche.hold - dt);
    object.niche.cooldown = Math.max(0, before.niche.cooldown - dt);
    object.x = object.perceptualPosition[0]; object.y = object.perceptualPosition[1];
    object.vx = object.perceptualVelocity[0]; object.vy = object.perceptualVelocity[1];
    object.brightness = object.perceptualPosition[0];
  }
  const bar = Math.floor((world.time + dt) * world.tempo / 240);
  if (bar > world.lastBar) {
    resolvePersistentConflicts(world, world.objects, separation, scatter);
    world.lastBar = bar;
  }
  world.time += dt;
}

export function stepWorld(world, rawDt) {
  world.accumulator += clamp(rawDt, 0, 0.1);
  while (world.accumulator + 1e-12 >= FIXED_DT) {
    fixedStep(world, FIXED_DT);
    world.accumulator -= FIXED_DT;
  }
  world.metrics = measureWorld(world);
  return world;
}

export function setInteraction(world, interaction) { world.interaction = interaction; }

export function setHarmonicCenter(world, midiNote, velocity = 1) {
  world.harmonicCenter = ((midiNote % 12) + 12) % 12;
  world.harmonicField[world.harmonicCenter] += clamp(velocity, 0, 1) * 1.4;
  world.harmonicField[(world.harmonicCenter + 7) % 12] += clamp(velocity, 0, 1) * 0.62;
}

export function injectEnergy(world, amount) {
  for (const object of world.objects) object.energyVelocity += clamp(amount, 0, 1) * 0.22;
}

export function measureWorld(world) {
  const phases = world.objects.map((object) => object.phase * TAU);
  const re = mean(phases.map(Math.cos));
  const im = mean(phases.map(Math.sin));
  const phaseCoherence = Math.hypot(re, im);
  const meanVelocity = PERCEPTUAL_DIMENSIONS.map((_, d) => mean(world.objects.map((object) => object.perceptualVelocity[d])));
  const speeds = world.objects.map((object) => Math.sqrt(mean(object.perceptualVelocity.map((value) => value * value))));
  const collectiveSpeed = mean(speeds);
  const active = world.objects.filter((_, index) => speeds[index] > 0.0025);
  const meanSpeed = Math.sqrt(meanVelocity.reduce((sum, value) => sum + value * value, 0) / meanVelocity.length);
  const trendAgreement = active.length >= 2 && meanSpeed > 1e-6
    ? mean(active.map((object) => {
      const speed = Math.sqrt(object.perceptualVelocity.reduce((sum, value) => sum + value * value, 0));
      const direction = object.perceptualVelocity.reduce((sum, value, d) => sum + value * meanVelocity[d], 0);
      return clamp((direction / Math.max(speed * meanSpeed * Math.sqrt(meanVelocity.length), 1e-9) + 1) / 2);
    })) : 0;
  let masking = 0; let pairs = 0;
  for (let i = 0; i < world.objects.length; i += 1) for (let j = i + 1; j < world.objects.length; j += 1) { masking += conflict(world.objects[i], world.objects[j]); pairs += 1; }
  const identityDrift = mean(world.objects.map((object) => perceptualDistance(object.perceptualPosition, object.identityAnchor)));
  const center = PERCEPTUAL_DIMENSIONS.map((_, d) => mean(world.objects.map((object) => object.perceptualPosition[d])));
  const identitySpread = mean(world.objects.map((object) => perceptualDistance(object.perceptualPosition, center)));
  const metrics = {
    phaseCoherence: clamp(phaseCoherence),
    trendAgreement: clamp(trendAgreement),
    collectiveSpeed: clamp(collectiveSpeed * 10),
    trendActive: active.length >= 2,
    maskingCost: clamp(masking / Math.max(1, pairs)),
    identityDrift: clamp(identityDrift * 2),
    identitySpread: clamp(identitySpread * 2),
    decisionRate: mean(world.objects.map((object) => object.niche.decisions)) / Math.max(world.time, 1),
  };
  metrics.context = metrics.phaseCoherence;
  metrics.trend = metrics.trendAgreement;
  metrics.clarity = 1 - metrics.maskingCost;
  return metrics;
}

export function snapshotWorld(world) {
  return JSON.parse(JSON.stringify({ schema: world.schema, seed: world.seed, config: world.config, tempo: world.tempo, harmonicCenter: world.harmonicCenter, harmonicField: world.harmonicField, temperature: world.temperature, time: world.time, lastBar: world.lastBar, objects: world.objects, metrics: world.metrics }));
}
