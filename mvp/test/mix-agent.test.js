import test from 'node:test';
import assert from 'node:assert/strict';
import { decideVoiceMix } from '../src/mix-agent.js';

test('声部 Agent 每日只探索一项音色参数，响度单独按合奏平衡修正', () => {
  const plan = decideVoiceMix({
    day: 4, treeId: 'bass', species: 'bass', actionId: 'explore',
    current: { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.02, pingPongSend: 0.03 },
    home: { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.02, pingPongSend: 0.03 },
    levels: { bass: { rms: 0.01 }, pad: { rms: 0.04 }, melody: { rms: 0.05 }, texture: { rms: 0.06 } },
  });
  assert.equal(plan.changes.filter((row) => row.domain === 'timbre').length, 1);
  assert.equal(plan.changes.find((row) => row.key === 'gain')?.to, 1.04);
  assert.ok(plan.timbreExploration > 0);
});

test('混音决策逐日可复现，削波时响度立即回收', () => {
  const input = {
    day: 12, treeId: 'melody', species: 'melody', clipWarn: true,
    current: { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.18, pingPongSend: 0.12 },
    home: { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.18, pingPongSend: 0.12 },
  };
  assert.deepEqual(decideVoiceMix(input), decideVoiceMix(input));
  assert.equal(decideVoiceMix(input).changes.find((row) => row.key === 'gain')?.to, 0.92);
});

test('四声部 256 日混音 mock 后仍在探索，且不会随机游走撞参数边界', () => {
  const speciesList = ['pad', 'melody', 'bass', 'texture'];
  for (const species of speciesList) {
    const home = { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.12, pingPongSend: 0.08 };
    const current = { ...home };
    const lateKeys = new Set();
    let lateMovement = 0;
    for (let day = 0; day < 256; day += 1) {
      const plan = decideVoiceMix({
        day, treeId: species, species,
        current, home,
        actionId: ['rest', 'perch', 'explore', 'balance'][day % 4],
        levels: Object.fromEntries(speciesList.map((name, index) => [name, {
          rms: 0.025 + ((day + index) % 5) * 0.005,
        }])),
      });
      for (const change of plan.changes) {
        current[change.key] = change.to;
        if (day >= 192 && change.domain === 'timbre') {
          lateKeys.add(change.key);
          lateMovement += Math.abs(change.to - change.from);
        }
      }
    }
    assert.equal(lateKeys.size, 5, `${species} 后 64 日五项音色维度均继续被访问`);
    assert.ok(lateMovement > 1, `${species} 后 64 日仍有可见参数运动`);
    for (const key of ['eqLowDb', 'eqMidDb', 'eqHighDb']) assert.ok(Math.abs(current[key]) < 5.5);
    for (const key of ['reverbSend', 'pingPongSend']) assert.ok(current[key] > 0.01 && current[key] < 0.44);
  }
});

test('四轨响度 1000 日闭环不会单向压到 gain 下限', () => {
  const speciesList = ['pad', 'melody', 'bass', 'texture'];
  const baseRms = { pad: 0.065, melody: 0.012, bass: 0.028, texture: 0.045 };
  const home = Object.fromEntries(speciesList.map((species) => [species, {
    gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.12, pingPongSend: 0.08,
  }]));
  const current = structuredClone(home);
  for (let day = 1; day <= 1000; day += 1) {
    const levels = Object.fromEntries(speciesList.map((species) => [species, {
      meanRms: baseRms[species] * current[species].gain,
    }]));
    const plans = speciesList.map((species) => [species, decideVoiceMix({
      day, treeId: species, species, current: current[species], home: home[species], levels,
    })]);
    for (const [species, plan] of plans) {
      for (const change of plan.changes) current[species][change.key] = change.to;
    }
  }
  const gains = speciesList.map((species) => current[species].gain);
  const geometricMean = Math.exp(gains.reduce((sum, gain) => sum + Math.log(gain), 0) / gains.length);
  assert.ok(gains.every((gain) => gain > 0.72 && gain < 1.33));
  assert.ok(geometricMean > 0.9 && geometricMean < 1.1);
});
