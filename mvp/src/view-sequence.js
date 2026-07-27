const positive = (value, fallback) => {
  const next = Math.trunc(Number(value));
  return Number.isInteger(next) && next > 0 ? next : fallback;
};

export function defaultViewSequenceDimensions({ pitchBranchCount = 5,
  barsPerDay = 4, beatsPerBar = 4 } = {}) {
  return Object.freeze({ pitchBranchCount: positive(pitchBranchCount, 5),
    stepCount: positive(barsPerDay, 4) * positive(beatsPerBar, 4) });
}

export function sequencePlayheadForViewTree(viewTree, dimensions = defaultViewSequenceDimensions()) {
  const phase = Number(viewTree?.phase);
  const normalized = Number.isFinite(phase) ? ((phase % 1) + 1) % 1 : 0;
  const rate = viewTree?.treeId === 'texture' || viewTree?.species === 'texture'
    ? positive(viewTree?.rate, 2) : 1;
  const position = ((normalized * rate) % 1) * positive(dimensions.stepCount, 1);
  const stepIndex = Math.min(dimensions.stepCount - 1, Math.floor(position));
  return Object.freeze({ stepIndex, stepProgress: position - stepIndex, normalizedPhase: normalized });
}
