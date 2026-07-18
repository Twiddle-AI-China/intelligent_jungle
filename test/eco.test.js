import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, rebuildBranches, stepWorld } from '../src/world.js';
import { stepEconomy, spawnPestWave, ecosystemHealth, stagnation, ECONOMY } from '../src/eco/economy.js';
import { flockPolicy, masterPolicy } from '../src/eco/agent.js';
import { velocityFromPerchCount, timbreFromHalo, richnessFromFoliage, impurityFromPest, dayNightMacros, masterFromHealth, mixFromCamera, SEASON_TO_CHORD } from '../src/eco/mapping.js';
import { CHORD_QUALITIES } from '../src/score.js';

const CHORD = { rootMidi: 57, intervals: CHORD_QUALITIES.minor };
const BAND = (role) => ({ bass: { loMidi: 45, hiMidi: 50 }, support: { loMidi: 57, hiMidi: 64 }, ornament: { loMidi: 64, hiMidi: 71 }, shimmer: { loMidi: 57, hiMidi: 69 } }[role]);
function run(world, seconds) { for (let t = 0; t < seconds; t += 1 / 60) stepWorld(world, 1 / 60); }

test('economy: pest wave raises pest, woodpecker clearing reduces it', () => {
  const world = createWorld({ seed: 11 });
  rebuildBranches(world, CHORD, BAND);
  spawnPestWave(world, 3, 0.3); // 啄木鸟己树（index 3）
  assert.ok(world.trees[3].pest > 0.2);
  world.flocks[3].dwellUrge = 0.95; // 多停驻清理
  run(world, 20);
  assert.ok(world.trees[3].pest < 0.25, `pest should fall, got ${world.trees[3].pest}`);
});

test('agent: woodpecker policy dwells more when its own tree is pest-ridden', () => {
  const world = createWorld({ seed: 12 });
  const wp = world.flocks[3];
  spawnPestWave(world, 3, 0.4);
  const buggy = flockPolicy(world, wp).dwellUrge;
  world.trees[3].pest = 0;
  const clean = flockPolicy(world, wp).dwellUrge;
  assert.ok(buggy > clean, `buggy ${buggy} should exceed clean ${clean}`);
});

test('agent: pelican policy restrains dwelling when its tree is weak', () => {
  const world = createWorld({ seed: 13 });
  const pelican = world.flocks[0];
  world.trees[0].foliage = 0.2;
  const weak = flockPolicy(world, pelican).dwellUrge;
  world.trees[0].foliage = 0.95;
  const strong = flockPolicy(world, pelican).dwellUrge;
  assert.ok(weak < strong, `weak ${weak} should be < strong ${strong}`);
});

test('agent: master spawns pest wave only when stagnant and off cooldown', () => {
  const world = createWorld({ seed: 14 });
  const health = { mean: 0.8, min: 0.7 };
  const ops = masterPolicy(world, health, 0.9, 0);
  assert.ok(ops.some((o) => o.type === 'spawn_pest_wave'));
  assert.equal(masterPolicy(world, health, 0.9, 5).filter((o) => o.type === 'spawn_pest_wave').length, 0);
  assert.equal(masterPolicy(world, health, 0.1, 0).filter((o) => o.type === 'spawn_pest_wave').length, 0);
});

test('mapping: perch count → three velocity tiers', () => {
  assert.equal(velocityFromPerchCount(0), 0);
  assert.ok(velocityFromPerchCount(1) < velocityFromPerchCount(2));
  assert.ok(velocityFromPerchCount(2) < velocityFromPerchCount(3));
  assert.equal(velocityFromPerchCount(5), velocityFromPerchCount(3)); // 封顶
});

test('mapping: foliage and pest translate to richness and impurity', () => {
  assert.ok(richnessFromFoliage(1).reverbSend > richnessFromFoliage(0).reverbSend);
  assert.ok(impurityFromPest(1).noiseMix > impurityFromPest(0).noiseMix);
  assert.ok(masterFromHealth(0).lofiMix > masterFromHealth(1).lofiMix);
});

test('mapping: day-night is darker and sparser at midnight than noon', () => {
  const noon = dayNightMacros(0.25); const midnight = dayNightMacros(0.75);
  assert.ok(noon.filterMacro > midnight.filterMacro);
  assert.ok(noon.densityCap > midnight.densityCap);
});

test('mapping: camera focus attenuates other trees only', () => {
  const mix = mixFromCamera(1, 1, [0, 1, 2, 3]);
  assert.equal(mix[1], 1);
  assert.ok(mix[0] < 1 && mix[2] < 1 && mix[3] < 1);
  assert.deepEqual(mixFromCamera(0, 1, [0, 1, 2, 3]), { 0: 1, 1: 1, 2: 1, 3: 1 });
});

test('mapping: seasons map to chord colors', () => {
  assert.equal(SEASON_TO_CHORD.spring, 'major');
  assert.equal(SEASON_TO_CHORD.winter, 'minor');
});
