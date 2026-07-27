import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ecologicalRelations as legacyRelations,
  projectRelationsToXY as legacyProjection,
} from '../../../../mvp/src/ecological-latent.js';
import { ecologicalRelations } from '../../src/latent/relations.js';
import { projectRelationsToXY } from '../../src/latent/projection.js';
import { LATENT_ECOLOGY_CONFIG, LATENT_VOICES } from '../../src/latent/voice-config.js';
import { createSimulationRuntime } from '../../src/simulation-runtime.js';

test('provider failure remains non-blocking and late results do not mutate the world', () => {
  const agents = {
    scheduleReview() { return false; },
    acceptEnvelope() { return false; },
    takeForBoundary({ currentDomain }) {
      return {
        species: { source: 'policy', status: 'provider_error', value: currentDomain, reason: 'offline' },
        master: { source: 'policy', status: 'provider_error', value: currentDomain, reason: 'offline' },
      };
    },
  };
  const runtime = createSimulationRuntime({ seed: 17, agents });
  try {
    runtime.setAgentContext({ worldGeneration: 'generation-a', currentWorldRevision: 0 });
    const before = runtime.getSnapshot();
    for (let index = 0; index < 120; index += 1) runtime.tick(1 / 30);
    const advanced = runtime.getSnapshot();
    assert.ok(advanced.simTime > before.simTime);
    const stale = runtime.acceptAgentResult({ requestId: 'late' });
    assert.equal(stale.commandResult.accepted, false);
    assert.deepEqual(runtime.getSnapshot(), advanced);
  } finally {
    runtime.dispose();
  }
});

test('backend ecological cursor projection matches the frozen legacy oracle', () => {
  const tree = {
    id: 'melody', species: 'melody', branches: Array.from({ length: 5 }, () => ({})),
    birds: [
      { state: 'perched', branchId: 1, energy: 0.8, dwellBeatTime: 4, switchesUsed: 2 },
      { state: 'flying', branchId: 4, energy: 0.4, dwellBeatTime: 0, switchesUsed: 1 },
    ],
  };
  const snapshot = {
    simTime: 3, dayLength: 16,
    trees: [tree, {
      id: 'pad', species: 'pad', branches: [],
      birds: [{ state: 'flying', energy: 0.5, switchesUsed: 0 }],
    }],
  };
  const legacyConfig = {
    agent: { branchCount: LATENT_ECOLOGY_CONFIG.branchCount },
    latentAgent: {
      dwellReferenceBeats: LATENT_ECOLOGY_CONFIG.dwellReferenceBeats,
      switchReference: LATENT_ECOLOGY_CONFIG.switchReference,
    },
    voiceEngine: { species: { bass: {}, pad: {}, melody: {} } },
  };
  const legacy = legacyRelations(tree, snapshot, legacyConfig);
  const backend = ecologicalRelations(tree, snapshot, LATENT_ECOLOGY_CONFIG);
  assert.equal(backend.length, 8);
  backend.forEach((value, index) => assert.ok(Math.abs(value - legacy[index]) <= 1e-9));
  const legacyXY = legacyProjection(legacy, LATENT_VOICES.melody.projection);
  const backendXY = projectRelationsToXY(backend, LATENT_VOICES.melody.projection);
  assert.ok(Math.abs(backendXY.x - legacyXY[0]) <= 1e-9);
  assert.ok(Math.abs(backendXY.y - legacyXY[1]) <= 1e-9);
});
