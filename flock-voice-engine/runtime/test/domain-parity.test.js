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

test('domain migration ledger 固定且 exact-copy source SHA 全部一致', async () => {
  const ledger = await readJson(`${RUNTIME}/domain-migration.json`);
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.behaviorOwner, 'mvp/src');
  assert.equal(ledger.candidateMode, 'shadow-only');
  assert.equal(ledger.deleteByPhase, 5);
  assert.equal(ledger.files.length, 12);
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
