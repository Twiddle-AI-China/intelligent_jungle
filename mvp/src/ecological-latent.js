// Ecological state -> neural timbre map.
//
// Agents never write timbre coordinates. They change dwell, density, activity and
// branch behaviour in world; this fixed mapping observes those visible facts and
// continuously translates them to each instrument's safe kNN/XY timbre map.

const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

function mean(values, fallback = 0) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function branchStats(tree, branchCount) {
  const perched = tree.birds.filter((bird) => bird.state === 'perched');
  const denom = Math.max(1, branchCount - 1);
  const normalized = perched
    .map((bird) => Number(bird.branchId) / denom)
    .filter(Number.isFinite)
    .map((value) => clamp(value));
  const center = mean(normalized, 0.5);
  const variance = mean(normalized.map((value) => (value - center) ** 2));
  return { center, spread: clamp(Math.sqrt(variance) * 2) };
}

/**
 * Eight ecological relationship values, all normalized to [0, 1].
 * Names intentionally describe measurable world facts rather than latent semantics.
 */
export function ecologicalRelations(tree, snapshot, config) {
  const birds = tree?.birds ?? [];
  const total = Math.max(1, birds.length);
  const perched = birds.filter((bird) => bird.state === 'perched');
  const branchCount = tree?.branches?.length || config.agent?.branchCount || 5;
  const { center, spread } = branchStats(tree, branchCount);
  // Texture/drums is deliberately outside this feature. Only trees with an explicit
  // neural voice binding participate in inter-instrument relationship inputs.
  const otherTrees = (snapshot.trees ?? []).filter((candidate) => candidate.id !== tree.id
    && config.voiceEngine?.species?.[candidate.species]);
  const neighborActivity = mean(otherTrees.map((candidate) => {
    const candidateBirds = candidate.birds ?? [];
    if (!candidateBirds.length) return 0;
    return candidateBirds.filter((bird) => bird.state === 'flying').length / candidateBirds.length;
  }));
  const dwellReference = Math.max(1, Number(config.latentAgent?.dwellReferenceBeats) || 8);
  const switchReference = Math.max(1, Number(config.latentAgent?.switchReference) || 8);

  return [
    perched.length / total,                                                // cohesion / occupancy
    mean(birds.map((bird) => clamp(Number(bird.energy) || 0))),             // shared energy
    spread,                                                                // branch expansion
    center,                                                                // branch center
    clamp(mean(perched.map((bird) => Number(bird.dwellBeatTime) || 0)) / dwellReference),
    clamp(mean(birds.map((bird) => Number(bird.switchesUsed) || 0)) / switchReference),
    birds.filter((bird) => bird.activeToday !== false).length / total,      // active cohort
    clamp(neighborActivity),                                                // inter-tree response
  ].map((value) => clamp(Number.isFinite(value) ? value : 0));
}

export function projectRelationsToXY(relations, projection = {}) {
  const centered = relations.map((value) => clamp(value) * 2 - 1);
  const matrix = projection.matrix ?? [[1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0]];
  const bias = projection.bias ?? [0, 0];
  const extent = Math.max(0, Number(projection.extent) || 0.8);
  return [0, 1].map((axis) => {
    const weights = matrix[axis] ?? [];
    const weightSum = weights.reduce((sum, weight) => sum + Math.abs(Number(weight) || 0), 0) || 1;
    const value = centered.reduce((sum, input, index) => sum + input * (Number(weights[index]) || 0), 0) / weightSum;
    return clamp((Number(bias[axis]) || 0) + value * extent, -extent, extent);
  });
}

export function createEcologicalLatentController({ config, send }) {
  const settings = config.latentAgent ?? {};
  const interval = 1 / Math.max(1, Number(settings.updateHz) || 10);
  const tau = Math.max(0.01, Number(settings.smoothingSeconds) || 4);
  const states = new Map();
  let elapsed = 0;

  function update(snapshot, dt, getControl = () => 'AGENT') {
    if (!settings.enabled || !snapshot?.trees) return [];
    elapsed += Math.max(0, Number(dt) || 0);
    if (elapsed + 1e-9 < interval) return [];
    const step = elapsed;
    elapsed = 0;
    const alpha = 1 - Math.exp(-step / tau);
    const updates = [];

    for (const tree of snapshot.trees) {
      const species = tree.species ?? config.trees.find((item) => item.id === tree.id)?.species;
      const voice = config.voiceEngine?.species?.[species];
      if (!species || !voice || getControl(tree.id) !== 'AGENT') continue;
      const relations = ecologicalRelations(tree, snapshot, config);
      const target = projectRelationsToXY(relations, settings.projections?.[species]);
      const previous = states.get(tree.id) ?? target;
      const xy = previous.map((value, index) => value + (target[index] - value) * alpha);
      states.set(tree.id, xy);
      const sent = send(species, xy, voice.k ?? settings.k ?? 4);
      updates.push({ treeId: tree.id, species, relations, target, xy, sent: !!sent });
    }
    return updates;
  }

  return {
    update,
    state: (treeId) => states.get(treeId)?.slice() ?? null,
  };
}
