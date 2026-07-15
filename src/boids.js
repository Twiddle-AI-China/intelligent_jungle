const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

export const DEFAULT_BOIDS_CONFIG = Object.freeze({
  count: 18,
  cohesion: 0.72,
  alignment: 1.05,
  separation: 1.35,
  separationEnabled: true,
  maxSpeed: 0.16,
  space: 1,
  depth: 0.8,
  neighborRadius: 0.18,
  separationRadius: 0.055,
  maxForce: 0.55,
  wander: 0.055,
  guide: 0.9,
  timeScale: 1.5,
});

export function createEcosystem(options = {}) {
  const seed = options.seed ?? 73;
  const config = { ...DEFAULT_BOIDS_CONFIG, ...(options.config ?? {}) };
  const random = mulberry32(seed);
  const birds = Array.from({ length: config.count }, (_, id) => {
    const azimuth = random() * TAU;
    const elevation = (random() - 0.5) * Math.PI;
    const radius = Math.cbrt(random()) * 0.14;
    const heading = random() * TAU;
    const vertical = (random() - 0.5) * 0.8;
    const speed = config.maxSpeed * (0.55 + random() * 0.35);
    return {
      id,
      x: 0.5 + Math.cos(azimuth) * Math.cos(elevation) * radius,
      y: 0.5 + Math.sin(azimuth) * Math.cos(elevation) * radius,
      z: 0.5 + Math.sin(elevation) * radius * config.depth,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      vz: vertical * speed * config.depth,
      phase: random() * TAU,
    };
  });
  const ecosystem = { seed, time: 0, accumulator: 0, birds, target: null, config, centroid: { x: 0.5, y: 0.5, z: 0.5 }, meanSpeed: 0, relationState: Array(8).fill(0) };
  measure(ecosystem);
  return ecosystem;
}

export function setGuideTarget(ecosystem, target) {
  ecosystem.target = target ? { x: clamp(Number(target.x), 0, 1), y: clamp(Number(target.y), 0, 1) } : null;
}

export function resetEcosystem(ecosystem) {
  const reset = createEcosystem({ seed: ecosystem.seed, config: { ...ecosystem.config } });
  Object.assign(ecosystem, reset);
  return ecosystem;
}

export function setBoidsControl(ecosystem, key, value) {
  const ranges = {
    cohesion: [0, 2.5], alignment: [0, 2.5], separation: [0, 2.5],
    maxSpeed: [0.04, 0.3], space: [0.5, 2], depth: [0, 1],
  };
  if (!ranges[key]) return false;
  ecosystem.config[key] = clamp(Number(value), ...ranges[key]);
  return ecosystem.config[key];
}

export function setBoidsFeature(ecosystem, key, enabled) {
  if (key !== 'separationEnabled') return false;
  ecosystem.config[key] = Boolean(enabled);
  return ecosystem.config[key];
}

function limit(x, y, z, maximum) {
  const length = Math.hypot(x, y, z);
  return length > maximum ? [x * maximum / length, y * maximum / length, z * maximum / length] : [x, y, z];
}

function steerToward(bird, x, y, z, maximumSpeed, maximumForce) {
  const distance = Math.hypot(x, y, z);
  if (distance < 1e-9) return [0, 0, 0];
  return limit(x / distance * maximumSpeed - bird.vx, y / distance * maximumSpeed - bird.vy, z / distance * maximumSpeed - bird.vz, maximumForce);
}

function fixedStep(ecosystem, dt) {
  const { birds, config } = ecosystem;
  const neighborRadius = config.neighborRadius * config.space;
  const separationRadius = config.separationRadius * config.space;
  const accelerations = birds.map((bird) => {
    let centerX = 0; let centerY = 0; let centerZ = 0; let alignX = 0; let alignY = 0; let alignZ = 0;
    let separateX = 0; let separateY = 0; let separateZ = 0; let neighbors = 0; let close = 0;
    for (const other of birds) {
      if (other === bird) continue;
      const dx = other.x - bird.x; const dy = other.y - bird.y; const dz = other.z - bird.z; const distance = Math.hypot(dx, dy, dz);
      if (distance < neighborRadius) {
        centerX += other.x; centerY += other.y; centerZ += other.z;
        alignX += other.vx; alignY += other.vy; alignZ += other.vz; neighbors += 1;
      }
      if (distance > 1e-6 && distance < separationRadius) {
        separateX -= dx / (distance * distance); separateY -= dy / (distance * distance); separateZ -= dz / (distance * distance); close += 1;
      }
    }
    let cohesionX = 0; let cohesionY = 0; let cohesionZ = 0; let alignmentX = 0; let alignmentY = 0; let alignmentZ = 0;
    if (neighbors) {
      [cohesionX, cohesionY, cohesionZ] = steerToward(bird, centerX / neighbors - bird.x, centerY / neighbors - bird.y, centerZ / neighbors - bird.z, config.maxSpeed, config.maxForce);
      [alignmentX, alignmentY, alignmentZ] = steerToward(bird, alignX / neighbors, alignY / neighbors, alignZ / neighbors, config.maxSpeed, config.maxForce);
    }
    if (close) [separateX, separateY, separateZ] = limit(separateX / close, separateY / close, separateZ / close, config.maxForce);
    const wanderAngle = bird.phase + ecosystem.time * 0.37 + bird.id * 0.91;
    const separation = config.separationEnabled ? config.separation : 0;
    let ax = cohesionX * config.cohesion + alignmentX * config.alignment + separateX * separation + Math.cos(wanderAngle) * config.wander;
    let ay = cohesionY * config.cohesion + alignmentY * config.alignment + separateY * separation + Math.sin(wanderAngle) * config.wander;
    let az = (cohesionZ * config.cohesion + alignmentZ * config.alignment + separateZ * separation + Math.sin(wanderAngle * 0.73) * config.wander) * config.depth;
    if (ecosystem.target) {
      const [guideX, guideY] = steerToward(bird, ecosystem.target.x - bird.x, ecosystem.target.y - bird.y, 0, config.maxSpeed, config.maxForce);
      ax += guideX * config.guide; ay += guideY * config.guide;
    }
    const margin = 0.12;
    if (bird.x < margin) ax += config.maxForce * (margin - bird.x) / margin;
    if (bird.x > 1 - margin) ax -= config.maxForce * (bird.x - (1 - margin)) / margin;
    if (bird.y < margin) ay += config.maxForce * (margin - bird.y) / margin;
    if (bird.y > 1 - margin) ay -= config.maxForce * (bird.y - (1 - margin)) / margin;
    const zMin = 0.5 - 0.45 * config.depth; const zMax = 0.5 + 0.45 * config.depth; const zMargin = Math.min(0.1, (zMax - zMin) * 0.25);
    if (config.depth === 0) az += (0.5 - bird.z) * 8 - bird.vz * 4;
    else {
      if (bird.z < zMin + zMargin) az += config.maxForce * (zMin + zMargin - bird.z) / Math.max(zMargin, 1e-6);
      if (bird.z > zMax - zMargin) az -= config.maxForce * (bird.z - (zMax - zMargin)) / Math.max(zMargin, 1e-6);
    }
    return limit(ax, ay, az, config.maxForce);
  });
  birds.forEach((bird, index) => {
    bird.vx += accelerations[index][0] * dt; bird.vy += accelerations[index][1] * dt; bird.vz += accelerations[index][2] * dt;
    [bird.vx, bird.vy, bird.vz] = limit(bird.vx, bird.vy, bird.vz, config.maxSpeed);
    const zMin = 0.5 - 0.45 * config.depth; const zMax = 0.5 + 0.45 * config.depth;
    bird.x = clamp(bird.x + bird.vx * dt, 0, 1); bird.y = clamp(bird.y + bird.vy * dt, 0, 1); bird.z = clamp(bird.z + bird.vz * dt, zMin, zMax);
  });
  ecosystem.time += dt;
  measure(ecosystem);
}

function measure(ecosystem) {
  const { birds } = ecosystem; const count = birds.length;
  ecosystem.centroid.x = birds.reduce((sum, bird) => sum + bird.x, 0) / count;
  ecosystem.centroid.y = birds.reduce((sum, bird) => sum + bird.y, 0) / count;
  ecosystem.centroid.z = birds.reduce((sum, bird) => sum + bird.z, 0) / count;
  ecosystem.meanSpeed = birds.reduce((sum, bird) => sum + Math.hypot(bird.vx, bird.vy, bird.vz), 0) / count;
  const meanVx = birds.reduce((sum, bird) => sum + bird.vx, 0) / count;
  const meanVy = birds.reduce((sum, bird) => sum + bird.vy, 0) / count;
  const meanVz = birds.reduce((sum, bird) => sum + bird.vz, 0) / count;
  const spread = birds.reduce((sum, bird) => sum + Math.hypot(bird.x - ecosystem.centroid.x, bird.y - ecosystem.centroid.y, bird.z - ecosystem.centroid.z), 0) / count;
  const aligned = Math.hypot(meanVx, meanVy, meanVz) / Math.max(ecosystem.meanSpeed, 1e-6);
  let expansion = 0; let circulation = 0; let turbulence = 0; let boundaryPressure = 0;
  for (const bird of birds) {
    const rx = bird.x - ecosystem.centroid.x; const ry = bird.y - ecosystem.centroid.y; const rz = bird.z - ecosystem.centroid.z; const radius = Math.max(Math.hypot(rx, ry, rz), 1e-6);
    expansion += (rx * bird.vx + ry * bird.vy + rz * bird.vz) / radius;
    circulation += (rx * bird.vy - ry * bird.vx) / radius;
    turbulence += Math.hypot(bird.vx - meanVx, bird.vy - meanVy, bird.vz - meanVz);
    boundaryPressure += Math.max(0, 0.12 - Math.min(bird.x, 1 - bird.x, bird.y, 1 - bird.y, bird.z, 1 - bird.z)) / 0.12;
  }
  const speed = ecosystem.config.maxSpeed;
  ecosystem.relationState = [
    clamp(1 - spread / 0.32, 0, 1) * 2 - 1,
    clamp(aligned, 0, 1) * 2 - 1,
    clamp(expansion / count / speed, -1, 1),
    clamp(ecosystem.meanSpeed / speed, 0, 1) * 2 - 1,
    clamp(circulation / count / speed, -1, 1),
    clamp(turbulence / count / speed, 0, 1) * 2 - 1,
    clamp(boundaryPressure / count, 0, 1) * 2 - 1,
    clamp((ecosystem.centroid.z - 0.5) / Math.max(0.45 * ecosystem.config.depth, 1e-6), -1, 1),
  ];
}

export function stepEcosystem(ecosystem, dt) {
  const fixed = 1 / 120;
  ecosystem.accumulator += Math.max(0, Math.min(0.1, Number(dt))) * ecosystem.config.timeScale;
  while (ecosystem.accumulator + 1e-12 >= fixed) { fixedStep(ecosystem, fixed); ecosystem.accumulator -= fixed; }
  return ecosystem;
}

export function snapshotEcosystem(ecosystem) {
  return {
    time: Number(ecosystem.time.toFixed(6)),
    centroid: Object.fromEntries(Object.entries(ecosystem.centroid).map(([key, value]) => [key, Number(value.toFixed(6))])),
    relationState: ecosystem.relationState.map((value) => Number(value.toFixed(6))),
    birds: ecosystem.birds.map((bird) => [bird.x, bird.y, bird.z, bird.vx, bird.vy, bird.vz].map((value) => Number(value.toFixed(6)))),
  };
}
