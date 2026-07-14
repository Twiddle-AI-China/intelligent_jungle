export const TAU = Math.PI * 2;
export const FIXED_DT = 1 / 200;
export const PERCEPTUAL_DIMENSIONS = ['brightness', 'roughness', 'noisiness', 'harmonicity', 'transientness', 'density'];

export const DEFAULT_CONFIG = Object.freeze({
  count: 6,
  tempo: 82,
  contextCoupling: 0.04,
  meterCoupling: 0.02,
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
    const velocity = anchor.map(() => (random() - 0.5) * 0.012);
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
      pulse: 0,
      niche: { hold: 0, cooldown: 0, action: null, decisions: 0 },
      x: anchor[0], y: anchor[1], vx: velocity[0], vy: velocity[1], brightness: anchor[0],
    };
  });
  return {
    schema: 2,
    seed,
    config,
    objects,
    tempo: config.tempo,
    harmonicCenter: 0,
    harmonicField: [1, 0, 0.18, 0.12, 0, 0.15, 0, 0.35, 0, 0.12, 0.08, 0],
    temperature: 0,
    time: 0,
    accumulator: 0,
    interaction: null,
    random,
    metrics: { phaseCoherence: 0, trendAgreement: 0, maskingCost: 0, identityDrift: 0, identitySpread: 0, decisionRate: 0, context: 0, trend: 0, clarity: 0 },
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

function contextCoupling(world, object, dt, gather) {
  let phaseForce = 0;
  let weights = 0;
  for (const other of world.objects) {
    if (other === object) continue;
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

function commonMotion(world, object, dt, guide, disturbance) {
  const position = object.perceptualPosition;
  const velocity = object.perceptualVelocity;
  const neighborVelocity = Array(velocity.length).fill(0);
  let weights = 0;
  for (const other of world.objects) {
    if (other === object) continue;
    const weight = affinity(object, other);
    for (let d = 0; d < velocity.length; d += 1) {
      const roleScale = d === 1 && object.role === 'ornament' ? -0.35 : 0.72 + ((object.id + d) % 3) * 0.12;
      neighborVelocity[d] += other.perceptualVelocity[d] * weight * roleScale;
    }
    weights += weight;
  }
  for (let d = 0; d < velocity.length; d += 1) {
    const aligned = neighborVelocity[d] / Math.max(weights, 1e-6);
    const userForce = d === 0 ? guide.dx : d === 1 ? guide.dy : (guide.dx - guide.dy) * 0.18;
    const deterministicNoise = Math.sin((world.time * 37 + object.id * 17 + d * 11) * 1.618) * disturbance * 0.018;
    velocity[d] += (aligned - velocity[d]) * world.config.commonMotion * dt;
    velocity[d] += userForce * dt * 0.42 + deterministicNoise * dt;
    velocity[d] += (object.identityAnchor[d] - position[d]) * world.config.identitySpring * dt;
    velocity[d] *= Math.pow(0.992, dt * 200);
    velocity[d] = clamp(velocity[d], -0.16, 0.16);
    position[d] = clamp(position[d] + velocity[d] * dt, 0.04, 0.96);
  }
}

function conflict(a, b) {
  const registerOverlap = Math.max(0, 1 - Math.abs((a.pitchRegister * 12 + a.pitchClass) - (b.pitchRegister * 12 + b.pitchClass)) / 12);
  const spectralOverlap = Math.max(0, 1 - Math.abs(a.perceptualPosition[0] - b.perceptualPosition[0]) * 2.2);
  const onsetOverlap = Math.max(0, 1 - Math.abs(shortestPhase(a.phase, b.phase)) * 7);
  const panOverlap = Math.max(0, 1 - Math.abs(a.pan - b.pan) * 1.5);
  return registerOverlap * 0.34 + spectralOverlap * 0.3 + onsetOverlap * 0.2 + panOverlap * 0.16;
}

function resolveNiche(world, a, b, scatter) {
  if (a.niche.cooldown > 0 || b.niche.cooldown > 0) return;
  const threshold = world.config.conflictThreshold - scatter * 0.22;
  if (conflict(a, b) <= threshold) return;
  const mover = a.niche.decisions < b.niche.decisions ? a : b.niche.decisions < a.niche.decisions ? b : (Math.sin(world.seed + world.time * 19 + a.id * 7 + b.id * 13) > 0 ? a : b);
  const candidates = [
    { name: 'register', cost: mover.role === 'bass' ? 0.8 : 0.38 },
    { name: 'brightness', cost: Math.abs(mover.perceptualPosition[0] - mover.identityAnchor[0]) + 0.22 },
    { name: 'phase', cost: 0.34 },
    { name: 'pan', cost: Math.abs(mover.pan) * 0.35 + 0.18 },
    { name: 'density', cost: Math.abs(mover.perceptualPosition[5] - mover.identityAnchor[5]) + 0.28 },
  ].sort((x, y) => x.cost - y.cost);
  const action = candidates[0].name;
  const direction = Math.sin(world.seed * 0.1 + mover.id * 2.3 + world.time * 5.1) >= 0 ? 1 : -1;
  if (action === 'register') mover.pitchRegister = clamp(mover.pitchRegister + direction, -2, 2);
  if (action === 'brightness') mover.perceptualPosition[0] = clamp(mover.perceptualPosition[0] + direction * 0.12, 0.04, 0.96);
  if (action === 'phase') mover.phase = wrap01(mover.phase + direction * 0.12);
  if (action === 'pan') mover.pan = clamp(mover.pan + direction * (0.2 + scatter * 0.18), -0.95, 0.95);
  if (action === 'density') mover.perceptualPosition[5] = clamp(mover.perceptualPosition[5] - 0.14, 0.12, 0.96);
  mover.niche = { hold: 0.25 + Math.abs(direction) * 0.28, cooldown: 0.7 + mover.id * 0.07, action, decisions: mover.niche.decisions + 1 };
}

function fixedStep(world, dt) {
  const interaction = world.interaction;
  const strength = interaction?.strength ?? 0;
  const gather = interaction?.mode === 'gather' ? strength : 0;
  const scatter = interaction?.mode === 'scatter' ? strength : 0;
  const disturbance = interaction?.mode === 'disturb' ? strength : 0;
  const guide = interaction?.mode === 'guide' ? { dx: interaction.dx ?? 0, dy: interaction.dy ?? 0 } : { dx: 0, dy: 0 };
  world.temperature += ((disturbance > 0 ? clamp(disturbance, 0, 1.5) : 0) - world.temperature) * dt / (disturbance > 0 ? 0.18 : world.config.recoverySeconds);
  for (let p = 0; p < 12; p += 1) world.harmonicField[p] *= Math.pow(gather > 0 ? 0.99996 : 0.99982, dt * 200);

  for (const object of world.objects) {
    const previousPhase = object.phase;
    const natural = world.tempo / 60 / 4 * object.naturalRate * (1 + world.temperature * Math.sin(object.id * 8.31 + world.time * 3.7) * 0.12);
    object.phase = wrap01(object.phase + natural * dt + contextCoupling(world, object, dt, gather));
    object.pulse = object.phase < previousPhase ? 1 : Math.max(0, object.pulse - dt * 3.5);
    if (object.phase < previousPhase) choosePitch(world, object);
    commonMotion(world, object, dt, guide, world.temperature);
    if (interaction?.mode === 'energize') object.energyVelocity += strength * dt * 0.28;
    object.energyVelocity += (0.48 - object.energy) * dt * 0.035;
    object.energyVelocity *= Math.pow(0.985, dt * 200);
    object.energy = clamp(object.energy + object.energyVelocity * dt, 0.12, 0.94);
    object.niche.hold = Math.max(0, object.niche.hold - dt);
    object.niche.cooldown = Math.max(0, object.niche.cooldown - dt);
    object.x = object.perceptualPosition[0]; object.y = object.perceptualPosition[1];
    object.vx = object.perceptualVelocity[0]; object.vy = object.perceptualVelocity[1];
    object.brightness = object.perceptualPosition[0];
  }
  for (let i = 0; i < world.objects.length; i += 1) for (let j = i + 1; j < world.objects.length; j += 1) resolveNiche(world, world.objects[i], world.objects[j], scatter);
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
  const trendDispersion = mean(world.objects.map((object) => perceptualDistance(meanVelocity, object.perceptualVelocity)));
  let masking = 0; let pairs = 0;
  for (let i = 0; i < world.objects.length; i += 1) for (let j = i + 1; j < world.objects.length; j += 1) { masking += conflict(world.objects[i], world.objects[j]); pairs += 1; }
  const identityDrift = mean(world.objects.map((object) => perceptualDistance(object.perceptualPosition, object.identityAnchor)));
  const center = PERCEPTUAL_DIMENSIONS.map((_, d) => mean(world.objects.map((object) => object.perceptualPosition[d])));
  const identitySpread = mean(world.objects.map((object) => perceptualDistance(object.perceptualPosition, center)));
  const metrics = {
    phaseCoherence: clamp(phaseCoherence),
    trendAgreement: clamp(1 - trendDispersion * 12),
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
  return JSON.parse(JSON.stringify({ schema: world.schema, seed: world.seed, config: world.config, tempo: world.tempo, harmonicCenter: world.harmonicCenter, harmonicField: world.harmonicField, temperature: world.temperature, time: world.time, objects: world.objects, metrics: world.metrics }));
}
