const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));

function mean(values, fallback = 0) {
  return values.length === 0
    ? fallback
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function branchStats(tree, branchCount) {
  const perched = tree.birds.filter((bird) => bird?.state === 'perched');
  const denominator = Math.max(1, branchCount - 1);
  const normalized = perched
    .map((bird) => Number(bird.branchId) / denominator)
    .filter(Number.isFinite)
    .map((value) => clamp(value));
  const center = mean(normalized, 0.5);
  const variance = mean(normalized.map((value) => (value - center) ** 2));
  return { center, spread: clamp(Math.sqrt(variance) * 2) };
}

export function ecologicalRelations(tree, snapshot, config) {
  const birds = Array.isArray(tree?.birds) ? tree.birds : [];
  const total = Math.max(1, birds.length);
  const perched = birds.filter((bird) => bird?.state === 'perched');
  const branchCount = Array.isArray(tree?.branches) && tree.branches.length > 0
    ? tree.branches.length : Math.max(1, Number(config?.branchCount) || 5);
  const { center, spread } = branchStats({ birds }, branchCount);
  const neuralSpecies = new Set(config?.neuralSpecies ?? []);
  const otherTrees = (Array.isArray(snapshot?.trees) ? snapshot.trees : []).filter((candidate) => (
    candidate?.id !== tree?.id && neuralSpecies.has(candidate?.species)
  ));
  const neighborActivity = mean(otherTrees.map((candidate) => {
    const candidateBirds = Array.isArray(candidate.birds) ? candidate.birds : [];
    if (candidateBirds.length === 0) return 0;
    return candidateBirds.filter((bird) => bird?.state === 'flying').length / candidateBirds.length;
  }));
  const dwellReference = Math.max(1, Number(config?.dwellReferenceBeats) || 8);
  const switchReference = Math.max(1, Number(config?.switchReference) || 8);
  return [
    perched.length / total,
    mean(birds.map((bird) => clamp(Number(bird?.energy) || 0))),
    spread,
    center,
    clamp(mean(perched.map((bird) => Number(bird?.dwellBeatTime) || 0)) / dwellReference),
    clamp(mean(birds.map((bird) => Number(bird?.switchesUsed) || 0)) / switchReference),
    birds.filter((bird) => bird?.activeToday !== false).length / total,
    clamp(neighborActivity),
  ].map((value) => clamp(Number.isFinite(value) ? value : 0));
}
