import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSurvivalAction,
  legalSurvivalActionIds,
  normalizeSurvivalAction,
  SURVIVAL_ACTION_IDS,
} from '../src/survival-actions.js';

const resources = (stamina, health, catchValue) => ({
  stamina: { value: stamina }, health: { value: health }, catch: { value: catchValue },
});
test('Master 只能从固定生存菜单选动作，菜单外参数整单拒绝', () => {
  assert.deepEqual(SURVIVAL_ACTION_IDS, ['hold', 'rest', 'recover', 'forage']);
  assert.equal(normalizeSurvivalAction('invent-midi', resources(60, 60, 60)), null);
  assert.equal(normalizeSurvivalAction({ id: 'forage', delta: 99 }, resources(10, 10, 0)), null,
    '危险状态禁止觅食，且不得接受模型自带 delta');
  assert.equal(normalizeSurvivalAction({ id: 'hold', delta: 99 }, resources(60, 60, 60)).suggestions.length, 0);
});

test('生命和体力硬护栏优先于捕获与 Master 心情', () => {
  assert.equal(decideSurvivalAction(resources(80, 15, 0), { mood: 'restless' }).id, 'recover');
  assert.equal(decideSurvivalAction(resources(15, 80, 0), { mood: 'restless' }).id, 'rest');
  assert.equal(decideSurvivalAction(resources(80, 80, 20)).id, 'forage');
  assert.equal(decideSurvivalAction(resources(60, 60, 60)).id, 'hold');
});

test('心情只在安全区提前选择合法动作', () => {
  const safe = resources(50, 50, 45);
  assert.equal(decideSurvivalAction(safe, { mood: 'protective' }).id, 'recover');
  assert.equal(decideSurvivalAction(safe, { mood: 'restless' }).id, 'forage');
  assert.deepEqual(legalSurvivalActionIds(safe), ['hold', 'rest', 'recover', 'forage']);
});
