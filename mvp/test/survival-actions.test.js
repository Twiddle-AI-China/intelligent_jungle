import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSurvivalAction,
  legalSurvivalActionIds,
  normalizeSurvivalAction,
  SURVIVAL_ACTION_IDS,
  survivalMoodForDay,
} from '../src/survival-actions.js';

const resources = (health, stamina, food) => ({
  health: { value: health }, stamina: { value: stamina }, food: { value: food },
});

test('Master 只能从固定策略菜单选动作，菜单外参数整单拒绝', () => {
  assert.deepEqual(SURVIVAL_ACTION_IDS, ['rest', 'perch', 'explore', 'balance']);
  assert.equal(normalizeSurvivalAction('invent-midi', resources(60, 60, 60)), null);
  assert.equal(normalizeSurvivalAction({ id: 'explore', delta: 99 }, resources(60, 10, 0)), null,
    '体力危险时禁止探索，且不得接受模型自带 delta');
  assert.ok(normalizeSurvivalAction({ id: 'perch', delta: 99 }, resources(60, 20, 60))
    .suggestions.every((row) => row.dimension !== 'activeBars'));
});

test('生命、体力和食物硬护栏优先于 Master 心情', () => {
  assert.equal(decideSurvivalAction(resources(15, 80, 10), { mood: 'curious' }).id, 'rest');
  assert.equal(decideSurvivalAction(resources(80, 15, 10), { mood: 'curious' }).id, 'perch');
  assert.equal(decideSurvivalAction(resources(80, 80, 20), { mood: 'protective' }).id, 'explore');
  assert.equal(decideSurvivalAction(resources(60, 60, 60), { mood: 'steady' }).id, 'balance');
});

test('安全区 mood 形成可复现随机性，且只能选择合法动作', () => {
  const safe = resources(50, 50, 55);
  assert.equal(decideSurvivalAction(safe, { mood: 'protective' }).id, 'rest');
  assert.equal(decideSurvivalAction(safe, { mood: 'curious' }).id, 'explore');
  assert.equal(decideSurvivalAction(safe, { mood: 'restless' }).id, 'perch');
  assert.deepEqual(legalSurvivalActionIds(safe), ['rest', 'perch', 'explore', 'balance']);
  assert.equal(survivalMoodForDay(7, 'pad'), survivalMoodForDay(7, 'pad'));
});
