import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEcologicalLatentController,
  ecologicalRelations,
  projectRelationsToXY,
} from '../src/ecological-latent.js';
import { CONFIG } from '../src/config.js';

function tree(id, species, birds) {
  return { id, species, branches: Array.from({ length: 5 }, (_, index) => ({ id: index })), birds };
}

const bird = (overrides = {}) => ({
  state: 'perched', branchId: 2, energy: 0.5, dwellBeatTime: 4,
  switchesUsed: 1, activeToday: true, ...overrides,
});

function snapshot() {
  return {
    trees: [
      tree('pad', 'pad', [bird({ branchId: 0 }), bird({ branchId: 4, energy: 1 })]),
      tree('melody', 'melody', [bird({ state: 'flying', branchId: null, switchesUsed: 8 })]),
      tree('bass', 'bass', [bird({ dwellBeatTime: 12 })]),
      tree('texture', 'texture', [bird({ state: 'flying', branchId: null })]),
    ],
  };
}

test('ecologicalRelations returns deterministic, normalized visible-world facts', () => {
  const snap = snapshot();
  const a = ecologicalRelations(snap.trees[0], snap, CONFIG);
  const b = ecologicalRelations(snap.trees[0], snap, CONFIG);
  assert.deepEqual(a, b);
  assert.equal(a.length, 8);
  assert.ok(a.every((value) => value >= 0 && value <= 1));
  assert.equal(a[0], 1, 'both pad birds are perched');
  assert.equal(a[2], 1, 'opposite branches produce maximum normalized spread');
  assert.equal(a[7], 0.5, 'neighbor activity ignores texture and averages melody/bass only');
});

test('fixed projection stays in configured safe XY extent', () => {
  const projection = CONFIG.latentAgent.projections.melody;
  const xy = projectRelationsToXY([1, 1, 1, 1, 1, 1, 1, 1], projection);
  assert.equal(xy.length, 2);
  assert.ok(xy.every((value) => Math.abs(value) <= projection.extent));
});

test('controller updates neural instruments, smooths changes, and pauses USER tree', () => {
  const calls = [];
  const controller = createEcologicalLatentController({
    config: { ...CONFIG, latentAgent: { ...CONFIG.latentAgent, updateHz: 10, smoothingSeconds: 2 } },
    send(species, xy, k) { calls.push({ species, xy: [...xy], k }); return true; },
  });
  const snap = snapshot();
  const first = controller.update(snap, 0.1, (id) => id === 'pad' ? 'USER' : 'AGENT');
  assert.deepEqual(first.map((entry) => entry.species).sort(), ['bass', 'melody']);
  assert.ok(!calls.some((entry) => entry.species === 'pad'), 'USER takeover pauses automatic pad roaming');
  assert.ok(!calls.some((entry) => entry.species === 'texture'), 'no neural voice mapping means no latent send');

  const before = controller.state('melody');
  snap.trees[1].birds[0] = bird({ branchId: 4, energy: 1, dwellBeatTime: 8 });
  const second = controller.update(snap, 0.1, () => 'AGENT');
  const melody = second.find((entry) => entry.species === 'melody');
  assert.ok(melody);
  assert.notDeepEqual(melody.target, before);
  assert.ok(melody.xy.some((value, index) => Math.abs(value - melody.target[index]) > 1e-6),
    'smoothed coordinate does not jump directly to a changed target');
  assert.ok(second.some((entry) => entry.species === 'pad'), 'pad resumes when control returns to AGENT');
});

test('Master 探索策略只加快安全映射追随，不直接写入潜空间坐标', () => {
  const sent = [];
  const config = {
    ...CONFIG,
    latentAgent: { ...CONFIG.latentAgent, enabled: true, updateHz: 10, smoothingSeconds: 4 },
  };
  const controller = createEcologicalLatentController({
    config,
    send: (species, xy) => { sent.push({ species, xy }); return true; },
  });
  const snap = snapshot();
  const normal = controller.update(snap, 0.1, () => 'AGENT', () => ({ latentDrive: 1 }));
  const explore = controller.update(snap, 0.1, () => 'AGENT', () => ({ latentDrive: 3 }));
  assert.ok(normal.every((row) => row.drive === 1));
  assert.ok(explore.every((row) => row.drive === 3));
  assert.ok(sent.every((row) => row.xy.every(Number.isFinite)));
});

test('探索策略在生态投影周围产生有界慢巡游，停止探索后回归生态目标', () => {
  const sent = [];
  const controller = createEcologicalLatentController({
    config: CONFIG,
    send: (_species, xy) => { sent.push(xy); return true; },
  });
  const snap = snapshot();
  snap.dayLength = 16;
  snap.simTime = 4;
  controller.update(snap, 1, () => 'AGENT', () => ({ id: 'explore', latentDrive: 3 }));
  const explored = sent.at(-1);
  snap.simTime = 12;
  controller.update(snap, 1, () => 'AGENT', () => ({ id: 'explore', latentDrive: 3 }));
  const moved = sent.at(-1);
  assert.notDeepEqual(moved, explored);
  assert.ok(moved.every((value) => Math.abs(value) <= 0.8));
});
