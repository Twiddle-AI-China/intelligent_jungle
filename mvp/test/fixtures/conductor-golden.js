function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CONDUCTOR_GOLDEN = deepFreeze({
  worldRngDrawCount: 264,
  conductorRngDrawCount: 9,
  snapshot: {
    simTime: 20,
    day: 2,
    phase: 0.33,
    bpm: 60,
    perchedTotal: 9,
  },
  frame: {
    season: 'spring',
    seasonDay: 1,
    seasonLength: 8,
    progressionStep: 1,
    progressionCycle: 0,
    progressionId: 'bloom',
    period: 'day',
    skeletonId: 'Gm',
    skeletonNotes: [55, 62, 67, 70, 74],
    colorId: '日光',
    colorNotes: [70, 74],
    tension: 0.26,
  },
  master: {
    control: 'AGENT',
    season: 'spring',
    seasonDay: 1,
    seasonLength: 8,
    colorId: '日光',
    period: 'day',
    progressionStep: 1,
    progressionCycle: 0,
    progressionId: 'bloom',
    pendingSeasonLength: null,
  },
  eventCounts: {
    perch: 37,
    unperch: 28,
    dawn: 1,
    dusk: 1,
    'sequence-pattern': 4,
  },
  firstEvent: {
    name: 'perch',
    treeId: 'texture',
    birdId: 14,
    branchId: 4,
    day: 1,
  },
  branchPreferences: {
    pad: [1, 0.7375, 1, 0.48305, 0.57055],
    melody: [1, 1, 1, 0.258, 0.258],
    bass: [1, 0.89075, 0.6895, 0.370122, 0.260872],
    texture: [1, 1, 1, 0.258, 0.258],
  },
  holdCounters: {
    pad: 0,
    melody: 1,
    bass: 0,
    texture: 0,
  },
  occupiedSequenceCells: {
    pad: [
      [4, 2, 1],
      [3, 3, 2],
    ],
    melody: [
      [0, 8, 1],
      [0, 14, 1],
      [1, 2, 1],
      [1, 9, 1],
      [1, 14, 1],
      [2, 7, 1],
      [2, 10, 1],
      [3, 2, 1],
    ],
    bass: [
      [1, 2, 1],
      [2, 2, 1],
      [4, 3, 1],
    ],
    texture: [
      [1, 0, 1],
      [4, 2, 1],
      [2, 3, 1],
      [4, 5, 1],
      [1, 6, 1],
      [4, 9, 1],
      [1, 10, 1],
      [0, 13, 1],
    ],
  },
  eventTraceSha256: '27467675016d2016ae53b8519249f7163daaf3b9c89d7b3a05c46ef0f4cbd934',
  callbackTraceSha256: '26bede9673d4f71b3c4e688999478648ff8e1156abb8f214f82e3f5d0c93eb1f',
});
