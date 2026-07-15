export const TAU = Math.PI * 2;
export const FIXED_DT = 1 / 200;
export const PERCEPTUAL_DIMENSIONS = ['brightness', 'roughness', 'noisiness', 'harmonicity', 'transientness', 'density'];
export const DORIAN_INTERVALS = Object.freeze([0, 2, 3, 5, 7, 9, 10]);

export const SPECIES = Object.freeze([
  { id: 'pulse', name: '脉冲群', role: 'bass', hue: 154, anchor: [0.24, 0.2, 0.16, 0.78, 0.62, 0.35], pitch: 0 },
  { id: 'resonance', name: '共鸣群', role: 'support', hue: 184, anchor: [0.52, 0.34, 0.2, 0.68, 0.35, 0.48], pitch: 5 },
  { id: 'texture', name: '纹理群', role: 'ornament', hue: 218, anchor: [0.7, 0.58, 0.62, 0.38, 0.72, 0.6], pitch: 9 },
]);

export const DEFAULT_CONFIG = Object.freeze({
  initialFlocks: 3,
  birdsPerFlock: 7,
  maxFlocks: 6,
  maxBirdsPerFlock: 32,
  tempo: 82,
  neighborRadius: 0.17,
  separationRadius: 0.052,
  obstacleRadius: 0.065,
  maxSpeed: 0.12,
  maxForce: 0.34,
  cohesionStrength: 1,
  alignmentStrength: 1,
  separationStrength: 1,
  latentStep: 0.16,
  clusterRadius: 0.085,
  minNoteBirds: 2,
  maxNoteGroups: 4,
  noteLength: 0.48,
  pitchTrendSteps: 1.5,
});

export const CONTROL_RANGES = Object.freeze({
  latentStep: [0.02, 0.8],
  maxSpeed: [0.04, 0.24],
  maxForce: [0.08, 0.8],
  neighborRadius: [0.08, 0.3],
  separationRadius: [0.025, 0.1],
  clusterRadius: [0.035, 0.2],
  minNoteBirds: [1, 5],
  cohesionStrength: [0, 2],
  alignmentStrength: [0, 2],
  separationStrength: [0, 2],
});

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const wrap01 = (value) => ((value % 1) + 1) % 1;
const delta = (target, source) => ((target - source + 1.5) % 1) - 0.5;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

export function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function limit(x, y, maximum) {
  const magnitude = Math.hypot(x, y);
  return magnitude > maximum && magnitude > 0 ? [x / magnitude * maximum, y / magnitude * maximum] : [x, y];
}

function createVoice(id, species) {
  return {
    id,
    speciesId: species.id,
    speciesName: species.name,
    role: species.role,
    hue: species.hue,
    identityAnchor: [...species.anchor],
    perceptualPosition: [...species.anchor],
    perceptualVelocity: species.anchor.map(() => 0),
    phase: id / 3,
    pulse: 0,
    energy: 0.4,
    energyVelocity: 0,
    pitchClass: species.pitch,
    pitchRegister: species.role === 'bass' ? -1 : species.role === 'ornament' ? 1 : 0,
    pitchZone: 0,
    pitchSemitones: 0,
    pan: 0,
    brightness: species.anchor[0],
    centroid: { x: 0.5, y: 0.5 },
    meanVelocity: { x: 0, y: 0 },
    spread: 0,
    meanSpeed: 0,
    alignment: 0,
    obstaclePressure: 0,
    population: 0,
    chartPosition: [0.5, 0.5],
    triggerSerial: 0,
    triggerStrength: 0,
    lastTriggerTime: -1,
    gate: 0,
    noteGroups: [],
  };
}

function makeBoid(world, flockId, x, y) {
  const angle = world.random() * TAU;
  const speed = world.config.maxSpeed * (0.42 + world.random() * 0.28);
  return {
    id: world.nextBoidId++,
    flockId,
    x: wrap01(x + (world.random() - 0.5) * 0.035),
    y: wrap01(y + (world.random() - 0.5) * 0.035),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    obstaclePressure: 0,
  };
}

export function createWorld(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const seed = options.seed ?? 0xc05a05;
  const random = mulberry32(seed);
  const world = {
    schema: 4,
    seed,
    config,
    random,
    nextBoidId: 1,
    nextObstacleId: 1,
    objects: [],
    boids: [],
    obstacles: [],
    tempo: config.tempo,
    harmonicCenter: 0,
    pulsePosition: 0,
    time: 0,
    accumulator: 0,
    interaction: null,
    metrics: { context: 0, trend: 0, clarity: 0, phaseCoherence: 0, trendAgreement: 0, collectiveSpeed: 0, trendActive: true, maskingCost: 0, identityDrift: 0, identitySpread: 0, decisionRate: 0 },
  };
  for (let id = 0; id < config.initialFlocks; id += 1) {
    const species = SPECIES[id % SPECIES.length];
    world.objects.push(createVoice(id, species));
    const angle = id / config.initialFlocks * TAU - Math.PI / 2;
    const centerX = 0.5 + Math.cos(angle) * 0.23;
    const centerY = 0.5 + Math.sin(angle) * 0.2;
    for (let bird = 0; bird < config.birdsPerFlock; bird += 1) world.boids.push(makeBoid(world, id, centerX, centerY));
  }
  updateVoices(world);
  world.metrics = measureWorld(world);
  return world;
}

export function addBoid(world, flockId, x, y) {
  const count = world.boids.filter((boid) => boid.flockId === flockId).length;
  if (!world.objects.some((voice) => voice.id === flockId) || count >= world.config.maxBirdsPerFlock) return false;
  world.boids.push(makeBoid(world, flockId, x, y));
  updateVoices(world);
  return true;
}

export function addFlock(world, speciesId, x = 0.5, y = 0.5) {
  if (world.objects.length >= world.config.maxFlocks) return false;
  const species = SPECIES.find((candidate) => candidate.id === speciesId) ?? SPECIES[world.objects.length % SPECIES.length];
  const id = world.objects.reduce((maximum, voice) => Math.max(maximum, voice.id), -1) + 1;
  world.objects.push(createVoice(id, species));
  for (let bird = 0; bird < world.config.birdsPerFlock; bird += 1) world.boids.push(makeBoid(world, id, x, y));
  updateVoices(world);
  return id;
}

export function addObstacle(world, x, y, radius = world.config.obstacleRadius) {
  world.obstacles.push({ id: world.nextObstacleId++, x: wrap01(x), y: wrap01(y), radius: clamp(radius, 0.025, 0.16) });
  return world.obstacles.at(-1).id;
}

export function eraseAt(world, x, y, radius = 0.045) {
  const obstacleIndex = world.obstacles.findIndex((obstacle) => Math.hypot(delta(obstacle.x, x), delta(obstacle.y, y)) <= obstacle.radius + radius * 0.4);
  if (obstacleIndex >= 0) { world.obstacles.splice(obstacleIndex, 1); return 'obstacle'; }
  let closest = -1; let closestDistance = radius;
  for (let index = 0; index < world.boids.length; index += 1) {
    const boid = world.boids[index];
    const distance = Math.hypot(delta(boid.x, x), delta(boid.y, y));
    const population = world.boids.filter((candidate) => candidate.flockId === boid.flockId).length;
    if (distance < closestDistance && population > 2) { closest = index; closestDistance = distance; }
  }
  if (closest >= 0) { world.boids.splice(closest, 1); updateVoices(world); return 'boid'; }
  return null;
}

function stepBoid(world, previous, before, dt) {
  let alignX = 0; let alignY = 0; let cohesionX = 0; let cohesionY = 0; let neighborWeight = 0;
  let separateX = 0; let separateY = 0;
  let guideTarget = null; let guideInfluence = 0;
  for (const other of previous) {
    if (other.id === before.id) continue;
    const dx = delta(other.x, before.x); const dy = delta(other.y, before.y);
    const distance = Math.hypot(dx, dy);
    if (distance > 0 && distance < world.config.separationRadius) {
      const pressure = (1 - distance / world.config.separationRadius) / Math.max(distance, 0.008);
      separateX -= dx * pressure; separateY -= dy * pressure;
    }
    if (other.flockId !== before.flockId || distance <= 0 || distance >= world.config.neighborRadius) continue;
    const weight = 1 - distance / world.config.neighborRadius;
    alignX += other.vx * weight; alignY += other.vy * weight;
    cohesionX += dx * weight; cohesionY += dy * weight;
    neighborWeight += weight;
  }
  let forceX = separateX * 0.022 * world.config.separationStrength; let forceY = separateY * 0.022 * world.config.separationStrength;
  if (neighborWeight > 0) {
    const aligned = limit(alignX / neighborWeight, alignY / neighborWeight, world.config.maxSpeed);
    forceX += (aligned[0] - before.vx) * 1.05 * world.config.alignmentStrength + cohesionX / neighborWeight * 0.42 * world.config.cohesionStrength;
    forceY += (aligned[1] - before.vy) * 1.05 * world.config.alignmentStrength + cohesionY / neighborWeight * 0.42 * world.config.cohesionStrength;
  }
  let obstaclePressure = 0;
  for (const obstacle of world.obstacles) {
    const awayX = delta(before.x, obstacle.x); const awayY = delta(before.y, obstacle.y);
    const distance = Math.hypot(awayX, awayY);
    const influenceRadius = obstacle.radius + 0.095;
    if (distance >= influenceRadius) continue;
    const pressure = 1 - distance / influenceRadius;
    forceX += awayX / Math.max(distance, 0.01) * pressure * 0.72;
    forceY += awayY / Math.max(distance, 0.01) * pressure * 0.72;
    obstaclePressure = Math.max(obstaclePressure, pressure);
  }
  const interaction = world.interaction;
  if (interaction?.mode === 'guide') {
    const dx = delta(interaction.x, before.x); const dy = delta(interaction.y, before.y);
    const influence = Math.exp(-(dx * dx + dy * dy) / 0.045);
    const dragX = interaction.dx ?? 0; const dragY = interaction.dy ?? 0;
    const dragMagnitude = Math.hypot(dragX, dragY);
    if (dragMagnitude > 0.002) {
      const targetSpeed = world.config.maxSpeed * 1.55;
      const targetVx = dragX / dragMagnitude * targetSpeed;
      const targetVy = dragY / dragMagnitude * targetSpeed;
      guideTarget = [targetVx, targetVy];
      guideInfluence = influence * (interaction.strength ?? 1);
    }
    forceX += dx * influence * 0.65;
    forceY += dy * influence * 0.65;
  }
  const boundedForce = limit(forceX, forceY, world.config.maxForce);
  const speedLimit = interaction?.mode === 'guide' ? world.config.maxSpeed * 1.55 : world.config.maxSpeed;
  let vx = before.vx + boundedForce[0] * dt; let vy = before.vy + boundedForce[1] * dt;
  if (guideTarget) {
    const response = (1 - Math.exp(-dt * 22)) * guideInfluence;
    vx += (guideTarget[0] - vx) * response;
    vy += (guideTarget[1] - vy) * response;
  }
  [vx, vy] = limit(vx, vy, speedLimit);
  if (Math.hypot(vx, vy) < world.config.maxSpeed * 0.3) {
    const heading = Math.atan2(vy, vx);
    vx = Math.cos(heading) * world.config.maxSpeed * 0.3; vy = Math.sin(heading) * world.config.maxSpeed * 0.3;
  }
  return { ...before, x: wrap01(before.x + vx * dt), y: wrap01(before.y + vy * dt), vx, vy, obstaclePressure };
}

function updateVoices(world) {
  for (const voice of world.objects) {
    const birds = world.boids.filter((boid) => boid.flockId === voice.id);
    if (!birds.length) continue;
    const reference = birds[0];
    const centroidX = wrap01(reference.x + mean(birds.map((boid) => delta(boid.x, reference.x))));
    const centroidY = wrap01(reference.y + mean(birds.map((boid) => delta(boid.y, reference.y))));
    const meanVx = mean(birds.map((boid) => boid.vx)); const meanVy = mean(birds.map((boid) => boid.vy));
    const meanSpeed = mean(birds.map((boid) => Math.hypot(boid.vx, boid.vy)));
    const spread = Math.sqrt(mean(birds.map((boid) => delta(boid.x, centroidX) ** 2 + delta(boid.y, centroidY) ** 2)));
    const alignment = Math.hypot(meanVx, meanVy) / Math.max(meanSpeed, 1e-6);
    const pressure = mean(birds.map((boid) => boid.obstaclePressure));
    voice.centroid = { x: centroidX, y: centroidY };
    voice.meanVelocity = { x: meanVx, y: meanVy };
    voice.spread = spread; voice.meanSpeed = meanSpeed; voice.alignment = clamp(alignment); voice.obstaclePressure = pressure; voice.population = birds.length;
    voice.chartPosition = [centroidX, centroidY];
    voice.noteGroups = buildNoteGroups(world, voice, birds);
    updateVoicePitch(world, voice);
    const headingX = meanVx / Math.max(meanSpeed, 1e-6);
    const targets = [
      voice.identityAnchor[0] + headingX * 0.16,
      voice.identityAnchor[1] + spread * 1.4 + pressure * 0.25,
      voice.identityAnchor[2] + pressure * 0.35,
      voice.identityAnchor[3] - spread * 0.75,
      voice.identityAnchor[4] + pressure * 0.4 + meanSpeed * 0.8,
      voice.identityAnchor[5] + (birds.length - world.config.birdsPerFlock) * 0.025 + meanSpeed * 0.9,
    ];
    for (let d = 0; d < targets.length; d += 1) {
      const target = clamp(targets[d], 0.04, 0.96);
      voice.perceptualVelocity[d] = (target - voice.perceptualPosition[d]) * 0.8;
      voice.perceptualPosition[d] += (target - voice.perceptualPosition[d]) * 0.018;
    }
    voice.pan += ((centroidX * 2 - 1) - voice.pan) * 0.025;
    voice.energy += (clamp(0.22 + meanSpeed * 3.2 + birds.length * 0.022, 0.16, 0.9) - voice.energy) * 0.02;
    voice.brightness = voice.perceptualPosition[0];
  }
}

function fixedStep(world, dt) {
  const previous = world.boids.map((boid) => ({ ...boid }));
  world.boids = previous.map((boid) => stepBoid(world, previous, boid, dt));
  updateVoices(world);
  const previousPulse = world.pulsePosition;
  const pulseAdvance = world.tempo / 60 * dt;
  world.pulsePosition = wrap01(previousPulse + pulseAdvance);
  const crossings = new Map();
  for (const boid of world.boids) {
    const distanceAhead = wrap01(boid.x - previousPulse);
    if (distanceAhead <= pulseAdvance + Math.abs(boid.vx) * dt) crossings.set(boid.flockId, (crossings.get(boid.flockId) ?? 0) + 1);
  }
  for (const voice of world.objects) {
    const previousPhase = voice.phase;
    const densityRate = 0.82 + voice.population / Math.max(1, world.config.birdsPerFlock) * 0.18 + voice.meanSpeed * 0.8;
    voice.phase = wrap01(voice.phase + world.tempo / 60 / 4 * densityRate * dt);
    voice.pulse = voice.phase < previousPhase ? 1 : Math.max(0, voice.pulse - dt * (3 + voice.obstaclePressure * 5));
    voice.gate = Math.max(0, voice.gate - dt * 3.5);
    const hitCount = crossings.get(voice.id) ?? 0;
    if (hitCount > 0 && world.time - voice.lastTriggerTime >= 0.09) {
      voice.triggerSerial += 1;
      voice.triggerStrength = clamp(0.48 + hitCount * 0.16, 0, 1);
      voice.lastTriggerTime = world.time;
      voice.gate = Math.max(voice.gate, voice.triggerStrength);
    }
  }
  world.time += dt;
}

export function stepWorld(world, rawDt) {
  world.accumulator += clamp(rawDt, 0, 0.1);
  while (world.accumulator + 1e-12 >= FIXED_DT) { fixedStep(world, FIXED_DT); world.accumulator -= FIXED_DT; }
  world.metrics = measureWorld(world);
  return world;
}

export function setInteraction(world, interaction) { world.interaction = interaction; }

function updateVoicePitch(world, voice) {
  const primary = voice.noteGroups[0];
  const zone = primary?.pitchZone ?? Math.min(DORIAN_INTERVALS.length - 1, Math.floor(clamp(voice.centroid.y, 0, 0.999999) * DORIAN_INTERVALS.length));
  voice.pitchZone = zone;
  voice.pitchClass = (world.harmonicCenter + DORIAN_INTERVALS[zone]) % 12;
  const species = SPECIES.find((candidate) => candidate.id === voice.speciesId) ?? SPECIES[0];
  let semitones = voice.pitchClass - species.pitch;
  while (semitones > 6) semitones -= 12;
  while (semitones < -6) semitones += 12;
  voice.pitchSemitones = semitones;
  for (const group of voice.noteGroups) {
    group.pitchClass = (world.harmonicCenter + DORIAN_INTERVALS[group.pitchZone]) % 12;
    let groupSemitones = group.pitchClass - species.pitch;
    while (groupSemitones > 6) groupSemitones -= 12;
    while (groupSemitones < -6) groupSemitones += 12;
    group.pitchSemitones = groupSemitones;
  }
}

function buildNoteGroups(world, voice, birds) {
  const pending = new Set(birds.map((bird) => bird.id));
  const byId = new Map(birds.map((bird) => [bird.id, bird]));
  const components = [];
  while (pending.size) {
    const seedId = pending.values().next().value;
    const queue = [seedId]; pending.delete(seedId);
    const component = [];
    while (queue.length) {
      const current = byId.get(queue.pop()); component.push(current);
      for (const candidateId of [...pending]) {
        const candidate = byId.get(candidateId);
        if (Math.hypot(delta(candidate.x, current.x), delta(candidate.y, current.y)) <= world.config.clusterRadius) {
          pending.delete(candidateId); queue.push(candidateId);
        }
      }
    }
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length || a[0].id - b[0].id);
  let audible = components.filter((group) => group.length >= Math.round(world.config.minNoteBirds));
  if (!audible.length && components.length) audible = [birds];
  audible = audible.slice(0, world.config.maxNoteGroups);
  return audible.map((group) => {
    const reference = group[0];
    const x = wrap01(reference.x + mean(group.map((bird) => delta(bird.x, reference.x))));
    const y = wrap01(reference.y + mean(group.map((bird) => delta(bird.y, reference.y))));
    const vx = mean(group.map((bird) => bird.vx));
    const vy = mean(group.map((bird) => bird.vy));
    const speed = mean(group.map((bird) => Math.hypot(bird.vx, bird.vy)));
    const spread = Math.sqrt(mean(group.map((bird) => delta(bird.x, x) ** 2 + delta(bird.y, y) ** 2)));
    const alignment = Math.hypot(vx, vy) / Math.max(speed, 1e-6);
    const baseZone = Math.min(DORIAN_INTERVALS.length - 1, Math.floor(clamp(y, 0, 0.999999) * DORIAN_INTERVALS.length));
    const trendShift = Math.round(clamp(vy / world.config.maxSpeed, -1, 1) * world.config.pitchTrendSteps);
    const pitchZone = Math.round(clamp(baseZone + trendShift, 0, DORIAN_INTERVALS.length - 1));
    const cohesion = 1 - clamp(spread / Math.max(world.config.clusterRadius, 1e-6));
    const durationSeconds = 0.08 + world.config.noteLength * cohesion * (0.65 + clamp(alignment) * 0.35);
    return { id: Math.min(...group.map((bird) => bird.id)), count: group.length, x, y, spread, trend: vy / Math.max(world.config.maxSpeed, 1e-6), pitchZone, pitchClass: 0, pitchSemitones: 0, durationSeconds, strength: Math.sqrt(group.length / birds.length) };
  });
}

export function setHarmonicCenter(world, midiNote) {
  world.harmonicCenter = ((midiNote % 12) + 12) % 12;
  for (const voice of world.objects) updateVoicePitch(world, voice);
}

export function setWorldControl(world, key, rawValue) {
  const range = CONTROL_RANGES[key];
  if (!range) return false;
  const value = clamp(Number(rawValue), range[0], range[1]);
  world.config[key] = key === 'minNoteBirds' ? Math.round(value) : value;
  if (key === 'maxSpeed') {
    for (const boid of world.boids) [boid.vx, boid.vy] = limit(boid.vx, boid.vy, value);
  }
  updateVoices(world);
  return world.config[key];
}

export function injectEnergy(world, amount) {
  const scale = 1 + clamp(amount, 0, 1) * 0.35;
  for (const boid of world.boids) { const bounded = limit(boid.vx * scale, boid.vy * scale, world.config.maxSpeed * 1.25); boid.vx = bounded[0]; boid.vy = bounded[1]; }
}

export function measureWorld(world) {
  const context = clamp(1 - mean(world.objects.map((voice) => voice.spread)) * 3.2);
  const trend = clamp(mean(world.objects.map((voice) => voice.alignment)));
  let overlap = 0; let pairs = 0;
  for (let i = 0; i < world.objects.length; i += 1) for (let j = i + 1; j < world.objects.length; j += 1) {
    const a = world.objects[i].centroid; const b = world.objects[j].centroid;
    overlap += Math.max(0, 1 - Math.hypot(delta(a.x, b.x), delta(a.y, b.y)) * 3.2); pairs += 1;
  }
  const maskingCost = clamp(overlap / Math.max(1, pairs));
  return {
    context, trend, clarity: 1 - maskingCost,
    phaseCoherence: context, trendAgreement: trend,
    collectiveSpeed: clamp(mean(world.objects.map((voice) => voice.meanSpeed)) / world.config.maxSpeed),
    trendActive: true, maskingCost,
    identityDrift: clamp(mean(world.objects.map((voice) => mean(voice.perceptualPosition.map((value, d) => Math.abs(value - voice.identityAnchor[d]))))) * 2),
    identitySpread: clamp(mean(world.objects.map((voice) => voice.spread)) * 3), decisionRate: 0,
  };
}

export function snapshotWorld(world) {
  return JSON.parse(JSON.stringify({ schema: world.schema, seed: world.seed, config: world.config, tempo: world.tempo, harmonicCenter: world.harmonicCenter, pulsePosition: world.pulsePosition, time: world.time, objects: world.objects, boids: world.boids, obstacles: world.obstacles, metrics: world.metrics }));
}
