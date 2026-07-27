function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const LATENT_VOICES = deepFreeze({
  bass: {
    assetVoice: 'bass', extent: 0.72, k: 4,
    projection: {
      extent: 0.72,
      matrix: [
        [0.34, 0.18, -0.12, -0.08, 0.22, -0.18, 0.12, 0.08],
        [-0.12, 0.25, 0.08, 0.18, 0.24, -0.20, 0.14, 0.10],
      ],
    },
  },
  pad: {
    assetVoice: 'pad', extent: 0.72, k: 4,
    projection: {
      extent: 0.72,
      matrix: [
        [0.26, 0.10, 0.22, -0.12, 0.24, -0.08, 0.04, 0.10],
        [0.18, 0.16, -0.10, 0.22, 0.20, -0.08, 0.06, 0.12],
      ],
    },
  },
  melody: {
    assetVoice: 'lead', extent: 0.78, k: 4,
    projection: {
      extent: 0.78,
      matrix: [
        [-0.08, 0.20, 0.14, 0.18, -0.16, 0.26, 0.18, 0.12],
        [0.06, 0.18, 0.16, -0.12, -0.18, 0.24, 0.28, 0.14],
      ],
    },
  },
});

export const LATENT_ECOLOGY_CONFIG = deepFreeze({
  branchCount: 5,
  dwellReferenceBeats: 8,
  switchReference: 8,
  neuralSpecies: Object.keys(LATENT_VOICES),
});
