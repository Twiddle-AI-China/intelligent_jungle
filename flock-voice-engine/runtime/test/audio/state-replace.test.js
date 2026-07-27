import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAudioRecoveryCommands, projectAudioState } from '../../src/audio/audio-state-projector.js';
import { createPrimingMasterPcmPublisher } from '../../src/audio/priming-master-pcm-publisher.js';

test('projector builds the fixed complete replacement DTO without aliases', () => {
  const session = { worldId: 'default', worldGeneration: 'g', revision: 7, seed: 4,
    kernel: { getSnapshot: () => ({ simTime: 2, trees: [{ species: 'bass' }], latent: {} }) } };
  const value = projectAudioState({ session, ready: { audioEpoch: 'e', renderFrame: 10n,
    geometry: { sampleRate: 44100, rowVoices: ['bass'] } } });
  assert.deepEqual(Object.keys(value).sort(), ['audioOwner', 'configRevision', 'deterministicSeed', 'frameMap',
    'latent', 'mix', 'stateRevision', 'voiceMode', 'voices', 'world'].sort());
  assert.equal(value.frameMap.renderFrame, '10');
});

test('active previews recover with one canonical all-off per active voice', () => {
  const simulationRuntime = { getSnapshot: () => ({ latent: {
    melody: { preview: { active: true } }, bass: { preview: { active: false } },
  } }) };
  assert.deepEqual(projectAudioRecoveryCommands({ simulationRuntime }), [
    { type: 'preview.allOff', voice: 'lead' },
  ]);
});

test('replacement assignments and active rows come only from ready geometry', () => {
  const snapshot = { simTime: 0, latent: {}, trees: [{ id: 'melody', species: 'melody', registerOffset: 0,
    birds: [{ id: 1, state: 'perched', branchId: 0 }] }] };
  const session = { worldId: 'default', worldGeneration: 'g', revision: 1, seed: 1,
    kernel: { getSnapshot: () => snapshot,
      getAudioProjection: () => ({ snapshot, chord: { notes: [60], melodyNotes: [64] } }) } };
  const value = projectAudioState({ session, ready: { audioEpoch: 'e', renderFrame: 0n,
    geometry: { sampleRate: 48000, rowVoices: ['bass', 'lead', 'pluck'] } } });
  assert.equal(value.voices.assignments.melody, 1);
  assert.deepEqual(value.voices.activeNotes, [{ row: 1, midi: 64, velocity: .42 }]);
});

test('texture replacement preserves Jungle sequence identity and edit metadata', () => {
  const snapshot = { simTime: 2, bpm: 90, latent: {}, trees: [{ id: 'texture', species: 'texture',
    registerOffset: 0, birds: [{ id: 8, state: 'perched', branchId: 4,
      sequenceAddress: { pitchBranchId: 4, stepIndex: 15, stepCount: 16 } }] }] };
  const session = { worldId: 'default', worldGeneration: 'g', revision: 3, seed: 1,
    kernel: { getSnapshot: () => snapshot, getAudioProjection: () => ({ snapshot,
      chord: { notes: [60], melodyNotes: [64], tension: .75 },
      jungleEditPlans: { texture: { breakEdit: 'dropout' } }, mix: {} }) } };
  const value = projectAudioState({ session, ready: { audioEpoch: 'e', renderFrame: 0n,
    geometry: { sampleRate: 44100, rowVoices: ['pluck'] } } });
  assert.deepEqual(value.voices.activeNotes, [{ row: 0, midi: 60, velocity: .42,
    pitchBranchId: 4, stepIndex: 15, tension: .75, masterBpm: 90,
    jungleEditPlan: { breakEdit: 'dropout' } }]);
});

test('pre-applied PCM cannot satisfy the post-replacement prime barrier', async () => {
  const blocks = [];
  const publisher = createPrimingMasterPcmPublisher({ downstream: { publish: (block) => blocks.push(block) } });
  publisher.hold();
  assert.equal(publisher.publish({ startFrame: 0n }), false);
  publisher.beginStream({ minStartFrame: 8192n });
  assert.equal(publisher.publish({ startFrame: 4096n }), false);
  let primed = false;
  publisher.waitForPostAppliedPrime().then(() => { primed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(primed, false);
  assert.equal(publisher.publish({ startFrame: 8192n }), true);
  await publisher.waitForPostAppliedPrime();
  assert.equal(publisher.publish({ startFrame: 12288n }), true);
  assert.deepEqual(blocks.map((block) => block.startFrame), [8192n, 12288n]);
});
