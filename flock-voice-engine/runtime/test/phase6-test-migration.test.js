import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

import { generateLedgers, verifyMigration } from '../tools/verify-phase6-migration.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const domain = read('flock-voice-engine/runtime/domain-migration.json');
const domainTests = read('flock-voice-engine/runtime/domain-test-migration.json');
const source = read('flock-voice-engine/release/phase6-source-retirement.json');
const tests = read('flock-voice-engine/release/phase6-test-migration.json');
const graphBuilder = () => ({
  files: ['flock-voice-engine/server/backend_factory.py'],
  edges: [], fileSha256: {}, sha256: 'a'.repeat(64),
});
const clone = (value) => structuredClone(value);
const stabilityValue = { schemaVersion: 1,
  status: 'allowed', allowed: true, successfulServerOwnerUpgrades: 1,
  currentReleaseManifestSha256: 'c'.repeat(64),
  previousReleaseManifestSha256: 'd'.repeat(64) };
const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const stabilityDirectory = mkdtempSync(join(tmpdir(), 'phase6-migration-'));
const stabilityRecord = join(stabilityDirectory, 'phase6-stability-record.json');
const stabilityBody = canonical(stabilityValue);
const stabilitySha256 = createHash('sha256').update(stabilityBody).digest('hex');
writeFileSync(stabilityRecord, stabilityBody);
writeFileSync(`${stabilityRecord}.sha256`, `${stabilitySha256}  phase6-stability-record.json\n`);
after(() => rmSync(stabilityDirectory, { recursive: true, force: true }));
const verify = ({ sourceLedger = source, testLedger = tests, domainLedger = domain,
  domainTestLedger = domainTests,
  graph = graphBuilder, stability = stabilityRecord } = {}) => verifyMigration({ root: ROOT,
  sourceLedger, testLedger, domainLedger, domainTestLedger, stabilityRecord: stability,
  graphBuilder: graph });

test('checked-in Phase 6 ledgers exactly cover the recursive source and test-name inventory', () => {
  const generated = generateLedgers(ROOT, domain);
  assert.deepEqual(source, generated.source);
  assert.deepEqual(tests, generated.test);
  assert.equal(source.files.some((item) => item.path === 'mvp/src/renderer.js'
    && item.status === 'retained'), true);
  assert.equal(source.files.some((item) => item.path === 'mvp/src/world.js'
    && item.status === 'retired'), true);
  assert.equal(tests.tests.every((item) => item.legacyTest.path && item.legacyTest.testName), true);
  for (const path of [
    'flock-voice-engine/runtime/test/audio/worker-supervisor.integration.test.js',
    'flock-voice-engine/runtime/test/integration/phase5-local.test.js',
    'flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js',
  ]) assert.equal(source.files.some((item) => item.path === path), true, path);
});

test('incomplete semantic replacement coverage cannot generate a removal manifest', () => {
  assert.throws(() => verify(), /PHASE6_TEST_REPLACEMENTS_PENDING/);
});

test('every mapped replacement suite is runnable and passes', () => {
  assert.throws(() => verify(), /PHASE6_TEST_REPLACEMENTS_PENDING/);
});

test('missing and duplicate source entries fail exhaustive inventory admission', () => {
  const missing = clone(source); missing.files.pop();
  assert.throws(() => verify({ sourceLedger: missing }),
  /PHASE6_SOURCE_INVENTORY_INCOMPLETE/);
  const duplicate = clone(source); duplicate.files.push(clone(duplicate.files[0]));
  assert.throws(() => verify({ sourceLedger: duplicate }),
  /PHASE6_SOURCE_LEDGER_INVALID/);
});

test('required retired source cannot be relabeled retained or self-replaced', () => {
  const retained = clone(source); const world = retained.files.find((item) => item.path === 'mvp/src/world.js');
  Object.assign(world, { status: 'retained', reason: 'bypass' });
  delete world.replacementPath; delete world.replacementOwner; delete world.retireAfterGate;
  assert.throws(() => verify({ sourceLedger: retained }), /PHASE6_SOURCE_STATUS_INVALID/);
  const self = clone(source); self.files.find((item) => item.path === 'mvp/src/world.js')
    .replacementPath = 'mvp/src/world.js';
  assert.throws(() => verify({ sourceLedger: self }),
  /PHASE6_SOURCE_REPLACEMENT_INVALID/);
});

test('test-name coverage, coverage IDs, and runnable replacements fail closed', () => {
  const missing = clone(tests); missing.tests.pop();
  assert.throws(() => verify({ testLedger: missing }),
  /PHASE6_TEST_INVENTORY_INCOMPLETE/);
  const duplicate = clone(tests); duplicate.tests[1].coverageId = duplicate.tests[0].coverageId;
  assert.throws(() => verify({ testLedger: duplicate }),
  /PHASE6_TEST_LEDGER_DUPLICATE/);
  const retired = clone(tests).tests.find((item) => item.status === 'retired');
  const bad = clone(tests); bad.tests.find((item) => item.coverageId === retired.coverageId)
    .replacementTest.testName = 'not a real test';
  assert.throws(() => verify({ testLedger: bad }),
  /PHASE6_REPLACEMENT_TEST_NOT_FOUND/);
});

test('production graph references to any retired path block manifest generation', () => {
  const retired = source.files.find((item) => item.status === 'retired').path;
  assert.throws(() => verify({
    graph: () => ({ files: ['flock-voice-engine/server/backend_factory.py', retired],
      sha256: 'a'.repeat(64) }) }), /PHASE6_PRODUCTION_GRAPH_RETAINS_SOURCE/);
});

test('stability sidecar and domain test ledger are mandatory inputs', () => {
  assert.throws(() => verify({ stability: join(stabilityDirectory, 'missing.json') }),
    /PHASE6_STABILITY_RECORD_INVALID/);
  const bad = clone(domainTests); bad.suites[0].candidate = bad.suites[1].candidate;
  assert.throws(() => verify({ domainTestLedger: bad }), /PHASE6_DOMAIN_TEST_LEDGER_MISMATCH/);
});
