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

test('静音轨不进响度参考：哑轨在场与缺席对其余三轨完全等价', () => {
  // texture 全天没出声（Mute 或 Jungle 极稀疏）。旧实现把它 floor 到 1e-4 一起算
  // 几何均值，参考值被拉低一个数量级，于是连本来偏静的 melody 也被判"过响"。
  const home = () => ({ gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.12, pingPongSend: 0.08 });
  const run = (speciesList, baseRms) => {
    const homes = Object.fromEntries(speciesList.map((s) => [s, home()]));
    const current = structuredClone(homes);
    for (let day = 1; day <= 400; day += 1) {
      const levels = Object.fromEntries(speciesList.map((s) => [s, {
        meanRms: baseRms[s] * current[s].gain,
      }]));
      for (const s of speciesList) {
        const plan = decideVoiceMix({
          day, treeId: s, species: s, current: current[s], home: homes[s], levels,
        });
        for (const change of plan.changes) current[s][change.key] = change.to;
      }
    }
    return Object.fromEntries(speciesList.map((s) => [s, current[s].gain]));
  };

  const withSilent = run(['pad', 'melody', 'bass', 'texture'],
    { pad: 0.065, melody: 0.012, bass: 0.028, texture: 0 });
  const withoutSilent = run(['pad', 'melody', 'bass'],
    { pad: 0.065, melody: 0.012, bass: 0.028 });

  for (const species of ['pad', 'melody', 'bass']) {
    assert.ok(Math.abs(withSilent[species] - withoutSilent[species]) < 1e-9,
      `${species}：哑轨在场不得改变结果（${withSilent[species]} vs ${withoutSilent[species]}）`);
  }
  assert.equal(withSilent.texture, 1, '自己当天没出声就不动，既不补也不扣');
  // 判别性断言：旧实现下 pad/melody/bass 会同时被压到 0.8 下限；
  // 现在偏静的 melody 必须仍然拿到补偿。
  assert.ok(withSilent.melody > 1, `melody 偏静应被补上来，实得 ${withSilent.melody}`);
});

test('自己静音时保持不动；只剩一条可闻轨时不做平衡判断', () => {
  const home = { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.12, pingPongSend: 0.08 };
  const silentSelf = decideVoiceMix({
    day: 3, treeId: 'texture', species: 'texture', current: { ...home }, home,
    levels: { pad: { meanRms: 0.06 }, melody: { meanRms: 0.05 }, bass: { meanRms: 0.04 }, texture: { meanRms: 0 } },
  });
  assert.equal(silentSelf.changes.some((row) => row.key === 'gain'), false);
  const onlyOne = decideVoiceMix({
    day: 3, treeId: 'pad', species: 'pad', current: { ...home }, home,
    levels: { pad: { meanRms: 0.06 }, melody: { meanRms: 0 }, bass: { meanRms: 0 }, texture: { meanRms: 0 } },
  });
  assert.equal(onlyOne.changes.some((row) => row.key === 'gain'), false);
});

test('削波有真正的衰减权限，且离开削波后平滑走回常规下限', () => {
  const home = { gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0.12, pingPongSend: 0.08 };
  // 四轨本身是平衡的：削波来自素材瞬态而非 gain 失衡，因此解除后应当回得来。
  const peers = { melody: { meanRms: 0.04 }, bass: { meanRms: 0.04 }, texture: { meanRms: 0.04 } };
  const levelsFor = (gain) => ({ pad: { meanRms: 0.04 * gain }, ...peers });
  const current = { ...home };
  for (let day = 1; day <= 40; day += 1) {
    const levels = levelsFor(current.gain);
    const plan = decideVoiceMix({
      day, treeId: 'pad', species: 'pad', current, home, levels, clipWarn: true,
    });
    for (const change of plan.changes) current[change.key] = change.to;
  }
  assert.ok(current.gain <= 0.56,
    `持续削波必须能压到 0.55 一线（≈−5dB），实得 ${current.gain.toFixed(3)}`);

  // 削波解除：不允许一步跳回 0.8，必须由回家项走上来。
  const afterClip = decideVoiceMix({
    day: 41, treeId: 'pad', species: 'pad', current, home, levels: levelsFor(current.gain), clipWarn: false,
  });
  const gainChange = afterClip.changes.find((row) => row.key === 'gain');
  assert.ok(gainChange, '解除削波后仍应有平衡修正');
  assert.ok(gainChange.to > current.gain, '应向上恢复');
  assert.ok(gainChange.to - current.gain < 0.12, '恢复是小步，不是跳变');
});
