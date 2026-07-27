import CONFIG_SNAPSHOT from './config-snapshot.json' with { type: 'json' };

const AUTHORITATIVE_CONFIG = structuredClone(CONFIG_SNAPSHOT);
AUTHORITATIVE_CONFIG.economy.prefs.pad.meanDwell.hi = Infinity;
AUTHORITATIVE_CONFIG.economy.prefs.bass.meanDwell.hi = Infinity;

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export function createDomainConfigProjection(source) {
  return deepFreeze(structuredClone({
    sim: source.sim,
    tempo: source.tempo,
    llm: {
      seasonLengthRange: source.llm.seasonLengthRange,
      masterCooldownDays: source.llm.masterCooldownDays,
    },
    harmony: source.harmony,
    tree: {
      trunkHeight: source.tree.trunkHeight,
      branches: source.tree.branches,
      perchSlotsPerBranch: source.tree.perchSlotsPerBranch,
      slotSpacing: source.tree.slotSpacing,
      slotStart: source.tree.slotStart,
    },
    trees: source.trees.map((tree) => ({
      id: tree.id,
      species: tree.species,
      xOffset: tree.xOffset,
      birdCount: tree.birdCount,
      mirror: tree.mirror,
      drawScale: tree.drawScale,
      registerOffset: tree.registerOffset,
      ...(Array.isArray(tree.pitchBranchWeights)
        ? { pitchBranchWeights: tree.pitchBranchWeights }
        : {}),
    })),
    birds: source.birds,
    species: source.species,
    dayCycle: source.dayCycle,
    agent: source.agent,
    economy: source.economy,
    mapping: source.mapping,
    audio: {
      filterBaseHz: source.audio.filterBaseHz,
      filterDaylightSpan: source.audio.filterDaylightSpan,
      nightGainScale: source.audio.nightGainScale,
      timbres: {
        pad: {
          voicingRange: source.audio.timbres.pad.voicingRange,
        },
        texture: {
          mode: source.audio.timbres.texture.mode,
          jungleTempoMultiplier: source.audio.timbres.texture.jungleTempoMultiplier,
        },
      },
    },
  }));
}

export const DOMAIN_CONFIG = createDomainConfigProjection(AUTHORITATIVE_CONFIG);
export const CONFIG = DOMAIN_CONFIG;
