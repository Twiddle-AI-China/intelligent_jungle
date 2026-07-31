function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const VOICE_ASSETS = Object.freeze({
  pad: ['assets/tree-pad.webp', 'assets/bird-pad.webp'],
  melody: ['assets/tree-melody.webp', 'assets/bird-melody.webp'],
  bass: ['assets/tree-bass.webp', 'assets/bird-bass.webp'],
  texture: ['assets/tree-texture.webp', 'assets/bird-texture.webp'],
});
const voice = (id, extra = {}) => ({ id, species: id,
  treeAsset: VOICE_ASSETS[id][0], birdAsset: VOICE_ASSETS[id][1], ...extra });

export const VIEW_CONFIG = freeze({
  tempo: { barsPerDay: 4, beatsPerBar: 4, defaultBpm: 60, bpmMin: 50, bpmMax: 90 },
  tree: { trunkHeight: 0.62 },
  trees: [voice('pad'), voice('melody', { mirror: true }), voice('bass'),
    voice('texture', { mirror: true })],
  audio: { timbres: {
    pad: { reverbSend: 0.68, gain: 1 }, melody: { reverbSend: 0.18, gain: 1 },
    bass: { reverbSend: 0.02, gain: 1 },
    texture: { reverbSend: 0.34, gain: 1.16, mode: 'jungle', jungleTempoMultiplier: 2 },
  } },
  visual: {
    paper: '#F2EAD8', ink: '#2E3E8F', accent: '#E75C26',
    paperNight: '#262C54', inkNight: '#E9DFC8', paperGrainAlpha: 0.05,
    backgroundAssets: { spring: 'assets/backgrounds/botanical-spring.webp',
      summer: 'assets/backgrounds/botanical-summer.webp',
      autumn: 'assets/backgrounds/botanical-autumn.webp',
      winter: 'assets/backgrounds/botanical-winter.webp' },
    backgroundOpacity: 0.5, backgroundBlurPx: 1.6, seasonFadeSeconds: 1.5,
    treeImage: 'assets/tree-alpha.webp', birdPerchedImage: 'assets/bird-perched.webp',
    birdFlyImage: 'assets/bird-fly.webp',
    celestialAssets: { sun: 'assets/third-party/linux-antiquity/sun.svg',
      moon: 'assets/third-party/linux-antiquity/moon.svg' },
    celestialRadiusRatio: 0.052, celestialArcHeightRatio: 0.18,
    celestialArcSpanRatio: 0.46, celestialArcDepthRatio: 0.24, celestialArcAlpha: 0.14,
    sunAlpha: 0.38, moonAlpha: 0.3, beatFlashAlpha: 0.1,
    sequenceOverlayEnabled: true, sequenceNodeAlpha: 0.17, sequenceBarNodeAlpha: 0.3,
    sequencePlayheadAlpha: 0.82, ringControlsOnCanvas: false,
    flashSeconds: 0.7, flashScale: 1.3,
    singleTree: {
      trunkMain: 'assets/single-tree/trunk-main.webp',
      trunkVariants: ['assets/single-tree/trunk-variant-a.webp',
        'assets/single-tree/trunk-variant-b.webp'],
      trunkCrownCap: 'assets/single-tree/tree-trunk-crown-cap.webp',
      trunkRootCap: 'assets/single-tree/tree-trunk-root-cap.webp',
      trunkDrawWidthRatio: 0.22, crownCapWidthRatio: 0.35, rootCapWidthRatio: 0.27,
      crownCapHeightRatio: 0.3, rootCapHeightRatio: 0.3, trunkCapAlpha: 0.56,
      branchJoinOffsetRatio: 0.22, branchHeightRatio: 0.9, branchAspectRatio: 4 / 3,
      branchAssets: { pad: 'assets/single-tree/branch-pad-right-v2.webp',
        melody: 'assets/single-tree/branch-melody-left.webp',
        bass: 'assets/single-tree/branch-bass-right-v2.webp',
        texture: 'assets/single-tree/branch-texture-left.webp' },
      branchNoteAnchors: Object.fromEntries(Object.entries({
        pad: [[.67,.86],[.67,.70],[.67,.53],[.67,.36],[.67,.18]],
        melody: [[.47,.82],[.43,.66],[.42,.51],[.39,.37],[.47,.22]],
        bass: [[.69,.84],[.69,.67],[.69,.50],[.69,.31],[.69,.13]],
        texture: [[.48,.75],[.43,.61],[.40,.47],[.42,.34],[.48,.21]],
      }).map(([id, anchors]) => [id, anchors.map(([x, y]) => ({ x, y }))])),
      birdPoses: {
        pad: { perchedLeft: 'assets/single-tree/birds/bird-pad-perched-left.webp',
          perchedRight: 'assets/single-tree/birds/bird-pad-perched-right.webp',
          flyingUp: 'assets/single-tree/birds/bird-pad-flying-up.webp',
          flyingDown: 'assets/single-tree/birds/bird-pad-flying-down.webp' },
        melody: { perchedLeft: 'assets/single-tree/birds/bird-melody-perched-left.webp',
          perchedRight: 'assets/single-tree/birds/bird-melody-perched-right.webp',
          flyingUp: 'assets/single-tree/birds/bird-melody-flying-up.webp',
          flyingDown: 'assets/single-tree/birds/bird-melody-flying-down.webp' },
        bass: { perchedLeft: 'assets/single-tree/birds/bird-bass-perched-left-v2.webp',
          perchedRight: 'assets/single-tree/birds/bird-bass-perched-right-v2.webp',
          flyingUp: 'assets/single-tree/birds/bird-bass-flying-up.webp',
          flyingDown: 'assets/single-tree/birds/bird-bass-flying-down.webp' },
        texture: { perchedLeft: 'assets/single-tree/birds/bird-texture-cling-left.webp',
          perchedRight: 'assets/single-tree/birds/bird-texture-cling-right.webp',
          flyingUp: 'assets/single-tree/birds/bird-texture-flying-up.webp',
          flyingDown: 'assets/single-tree/birds/bird-texture-flying-down.webp' },
      },
      ringAssets: { small: 'assets/single-tree/rings/ring-control-small.webp',
        medium: 'assets/single-tree/rings/ring-control-medium.webp',
        large: 'assets/single-tree/rings/ring-control-large.webp' },
    },
  },
});
