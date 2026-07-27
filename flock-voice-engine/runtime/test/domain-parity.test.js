import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../', import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const EXPECTED_DOMAIN_FILES = Object.freeze([
  'projection:mvp/src/config.js:flock-voice-engine/runtime/src/domain/config.js',
  'exact-copy:mvp/src/world.js:flock-voice-engine/runtime/src/domain/world.js',
  'exact-copy:mvp/src/sequence.js:flock-voice-engine/runtime/src/domain/sequence.js',
  'exact-copy:mvp/src/economy.js:flock-voice-engine/runtime/src/domain/economy.js',
  'exact-copy:mvp/src/harmony.js:flock-voice-engine/runtime/src/domain/harmony.js',
  'exact-copy:mvp/src/mapping.js:flock-voice-engine/runtime/src/domain/mapping.js',
  'exact-copy:mvp/src/jungle.js:flock-voice-engine/runtime/src/domain/jungle.js',
  'exact-copy:mvp/src/deterministic-conductor.js:flock-voice-engine/runtime/src/domain/deterministic-conductor.js',
  'exact-copy:mvp/src/deterministic-rng.js:flock-voice-engine/runtime/src/domain/deterministic-rng.js',
  'exact-copy:mvp/src/simulation-checkpoint.js:flock-voice-engine/runtime/src/domain/simulation-checkpoint.js',
  'exact-copy:mvp/src/master/policy.js:flock-voice-engine/runtime/src/domain/master/policy.js',
  'exact-copy:mvp/src/survival-actions.js:flock-voice-engine/runtime/src/domain/survival-actions.js',
]);

test('domain migration ledger 固定且 exact-copy source SHA 全部一致', async () => {
  const ledger = await readJson(`${RUNTIME}/domain-migration.json`);
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.behaviorOwner, 'mvp/src');
  assert.equal(ledger.candidateMode, 'shadow-only');
  assert.equal(ledger.deleteByPhase, 5);
  assert.deepEqual(
    ledger.files.map(({ mode, source, candidate }) => `${mode}:${source}:${candidate}`),
    EXPECTED_DOMAIN_FILES,
  );
  assert.equal(ledger.files.filter(({ mode }) => mode === 'projection').length, 1);

  for (const item of ledger.files) {
    assert.ok(['projection', 'exact-copy'].includes(item.mode));
    if (item.mode !== 'exact-copy') continue;
    const [source, candidate] = await Promise.all([
      readFile(`${ROOT}/${item.source}`),
      readFile(`${ROOT}/${item.candidate}`),
    ]);
    assert.equal(sha256(candidate), sha256(source), item.candidate);
  }
});

test('domain config projection 只保留 Node domain 必需字段', async () => {
  const { DOMAIN_CONFIG, createDomainConfigProjection } = await import('../src/domain/config.js');
  assert.deepEqual(DOMAIN_CONFIG, createDomainConfigProjection(DOMAIN_CONFIG));
  const serialized = JSON.stringify(DOMAIN_CONFIG);
  for (const forbidden of [
    'treeAsset', 'birdAsset', 'birdFrames', 'branchAnchors', 'layout',
    'voiceEngine', 'latentAgent', 'endpoint', 'url', 'secret', '8081',
    'StepFun', 'DeepSeek',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(Object.isFrozen(DOMAIN_CONFIG), true);
  assert.equal(Object.isFrozen(DOMAIN_CONFIG.trees), true);
});

test('checked-in config snapshot exactly projects the browser authority with two Infinity sentinels', async () => {
  const [{ CONFIG: browserConfig }, { DOMAIN_CONFIG, createDomainConfigProjection }, snapshot] = await Promise.all([
    import('../../../mvp/src/config.js'),
    import('../src/domain/config.js'),
    readJson(`${RUNTIME}/src/domain/config-snapshot.json`),
  ]);
  assert.deepEqual(DOMAIN_CONFIG, createDomainConfigProjection(browserConfig));
  const nullPaths = [];
  function visit(value, path = []) {
    if (value === null) { nullPaths.push(path.join('.')); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  }
  visit(snapshot);
  assert.deepEqual(nullPaths.sort(), [
    'economy.prefs.bass.meanDwell.hi',
    'economy.prefs.pad.meanDwell.hi',
  ]);
});
