import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpeciesRequest,
  parseSpeciesResponse,
  revalidateSpeciesPlan,
} from '../../src/agents/species-prompt.js';
import {
  buildMasterRequest,
  parseMasterResponse,
} from '../../src/agents/master-prompt.js';

const flockInput = {
  day: 3,
  flocks: [{
    species: 'melody', energy: 0.8, homeBranches: [0, 1], notes: [60, 64],
    tension: 0.3, skeletonBranchIds: [0, 1], colorBranchIds: [2, 3],
    menu: { dwellBeats: [0.5, 2], activeBars: [0, 4], holdLoops: [2, 8], maxMutations: 2 },
    sequencePattern: { version: 2, pitchBranchCount: 5, stepCount: 16, occupiedCells: [] },
  }],
};

const speciesOutput = {
  flocks: [{
    reason: '树冠稳定继续栖息', dwellBeats: 1, activeBars: 2, holdLoops: 4,
    mutations: [{ from: 0, to: 1 }], cellMutations: [],
  }],
  master: { ops: [] },
};

const masterInput = {
  menu: {
    seasons: ['spring', 'summer'],
    colorsBySeason: { spring: ['clear', 'mist'], summer: ['humid'] },
    seasonLengthRange: [8, 16], tensionRange: [0.2, 0.6],
    progressionsBySeason: { summer: ['bloom'] },
  },
  state: {
    season: 'spring', seasonDay: 3, seasonLength: 8, currentColorId: 'clear',
  },
  observations: { treeScores: [0.8], harmonyScores: [0.9], patternSimilarity: 0.2 },
};

test('species request keeps the frozen 8081 contract and strips musical payload leaks', () => {
  const body = buildSpeciesRequest(flockInput);
  assert.equal(body.model, 'bird_agent');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.response_format.type, 'json_schema');
  const schema = body.response_format.json_schema.schema;
  assert.deepEqual(Object.keys(schema.properties), ['reason', 'flocks', 'master']);
  assert.equal(schema.properties.master.properties.ops.maxItems, 0);
  assert.equal(JSON.stringify(body.messages[1]).includes('notes'), false);
  assert.deepEqual(parseSpeciesResponse(JSON.stringify(speciesOutput), flockInput), {
    flocks: [{
      dwellBeats: 1, activeBars: 2, holdLoops: 4,
      mutations: [{ from: 0, to: 1 }], cellMutations: [],
    }],
    master: { ops: [] },
  });
});

test('species output rejects extra fields, menu escapes, input echo, and truncation', () => {
  assert.equal(parseSpeciesResponse(JSON.stringify({ ...speciesOutput, echo: flockInput }), flockInput), null);
  assert.equal(parseSpeciesResponse(JSON.stringify({
    ...speciesOutput,
    flocks: [{ ...speciesOutput.flocks[0], holdLoops: 99 }],
  }), flockInput), null);
  assert.equal(parseSpeciesResponse(JSON.stringify({
    ...speciesOutput,
    flocks: [{ ...speciesOutput.flocks[0], mutations: [{ from: 4, to: 1 }] }],
  }), flockInput), null);
  assert.equal(parseSpeciesResponse('{"flocks":[', flockInput), null);
});

test('species plan is revalidated against current branches and Sequence occupancy', () => {
  const current = structuredClone(flockInput);
  current.flocks[0].sequencePattern.occupiedCells = [
    { pitchBranchId: 0, stepIndex: 0, count: 1 },
  ];
  const plan = {
    flocks: [{
      dwellBeats: 1, activeBars: 2, holdLoops: 4, mutations: [{ from: 0, to: 1 }],
      cellMutations: [{
        from: { pitchBranchId: 0, stepIndex: 0 },
        to: { pitchBranchId: 1, stepIndex: 1 },
      }],
    }],
    master: { ops: [] },
  };
  assert.notEqual(revalidateSpeciesPlan(plan, current), null);
  const changed = structuredClone(current);
  changed.flocks[0].sequencePattern.occupiedCells = [];
  assert.equal(revalidateSpeciesPlan(plan, changed), null);
  assert.equal(revalidateSpeciesPlan({
    ...plan,
    flocks: [{ ...plan.flocks[0], mutations: [{ from: 0, to: 9 }] }],
  }, current), null);
});

test('master uses the controlled json_object exception with canonical schema in prompt', () => {
  const body = buildMasterRequest(masterInput);
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.response_format.type, 'json_object');
  assert.match(body.messages[0].content, /"additionalProperties":false/);
  assert.match(body.messages[0].content, /"required":\[/);
  assert.equal(parseMasterResponse('{"unexpected":true}', masterInput), null);
  assert.equal(parseMasterResponse(JSON.stringify({
    reason: '越权换季', colorId: 'clear', tension: 0.3, duskColorShift: false,
    tempoIntent: 'hold', nextSeason: 'summer', seasonLength: 8, progressionId: 'bloom',
  }), masterInput), null);
});

test('master accepts only exact current-menu output and rejects musical prompt vocabulary', () => {
  const output = {
    reason: '林群保持清朗色彩', colorId: 'mist', tension: 0.4,
    duskColorShift: false, tempoIntent: 'hold',
    nextSeason: null, seasonLength: null, progressionId: null,
  };
  assert.deepEqual(parseMasterResponse(JSON.stringify(output), masterInput), {
    reason: output.reason, colorId: 'mist', tension: 0.4,
    duskColorShift: false, tempoIntent: 'hold',
  });
  const prompt = buildMasterRequest(masterInput).messages.map((entry) => entry.content).join('\n');
  for (const forbidden of ['midi', 'notes', 'chord']) {
    assert.equal(prompt.toLowerCase().includes(forbidden), false, forbidden);
  }
});
