import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const pair = ({ source, candidate }) => `${source}:${candidate}`;

const EXPECTED_SUITES = Object.freeze([
  'world.test.js', 'sequence.test.js', 'economy.test.js', 'harmony.test.js',
  'harmony-frame.test.js', 'mapping.test.js', 'jungle.test.js', 'agent.test.js',
  'daycycle.test.js', 'master-policy.test.js', 'survival-actions.test.js',
  'conductor-characterization.test.js', 'deterministic-rng.test.js',
  'simulation-checkpoint-schema.test.js', 'sequence-checkpoint.test.js',
  'world-checkpoint.test.js', 'deterministic-conductor.test.js',
  'simulation-checkpoint.test.js',
].map((name) => `mvp/test/${name}:flock-voice-engine/runtime/test/domain/${name}`));
const EXPECTED_SUPPORT = Object.freeze([
  'helpers.js',
  'fixtures/conductor-golden.js',
  'fixtures/conductor-scenario.js',
  'fixtures/checkpoint-owner.js',
].map((name) => `mvp/test/${name}:flock-voice-engine/runtime/test/domain/${name}`));
const EXPECTED_TEST_SOURCES = Object.freeze([
  'mvp/src/agent.js:flock-voice-engine/runtime/test/src/agent.js:exact-copy',
]);
const EXPECTED_ADAPTERS = Object.freeze([
  ['config.js', 'test-config-clone'],
  ['deterministic-conductor.js', 'one-line-reexport'],
  ['deterministic-rng.js', 'one-line-reexport'],
  ['economy.js', 'one-line-reexport'],
  ['harmony.js', 'one-line-reexport'],
  ['jungle.js', 'one-line-reexport'],
  ['mapping.js', 'one-line-reexport'],
  ['master/policy.js', 'one-line-reexport'],
  ['sequence.js', 'one-line-reexport'],
  ['simulation-checkpoint.js', 'one-line-reexport'],
  ['survival-actions.js', 'one-line-reexport'],
  ['world.js', 'one-line-reexport'],
].map(([name, kind]) => (
  `mvp/src/${name}:flock-voice-engine/runtime/test/src/${name}:${kind}`
)));

async function imports(path) {
  const source = await readFile(path, 'utf8');
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2]);
}

test('replacement test ledger 完整、无重复且所有 copy 字节一致', async () => {
  const ledger = JSON.parse(await readFile(`${RUNTIME}/domain-test-migration.json`, 'utf8'));
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.normalization, 'none-byte-for-byte');
  assert.deepEqual(ledger.suites.map(pair), EXPECTED_SUITES);
  assert.deepEqual(ledger.supportFiles.map(pair), EXPECTED_SUPPORT);
  assert.deepEqual(
    ledger.testSources.map(({ source, candidate, mode }) => `${source}:${candidate}:${mode}`),
    EXPECTED_TEST_SOURCES,
  );
  assert.deepEqual(
    ledger.adapters.map(({ source, candidate, kind }) => `${source}:${candidate}:${kind}`),
    EXPECTED_ADAPTERS,
  );

  const copies = [...ledger.suites, ...ledger.supportFiles, ...ledger.testSources];
  assert.equal(new Set(copies.map(({ source }) => source)).size, copies.length);
  assert.equal(new Set(copies.map(({ candidate }) => candidate)).size, copies.length);
  for (const item of copies) {
    const [source, candidate] = await Promise.all([
      readFile(`${ROOT}/${item.source}`),
      readFile(`${ROOT}/${item.candidate}`),
    ]);
    assert.equal(sha256(candidate), sha256(source), item.candidate);
  }
});

test('test adapters 只允许冻结的 config clone 和单行 re-export', async () => {
  const ledger = JSON.parse(await readFile(`${RUNTIME}/domain-test-migration.json`, 'utf8'));
  for (const adapter of ledger.adapters) {
    const source = await readFile(`${ROOT}/${adapter.candidate}`, 'utf8');
    if (adapter.kind === 'one-line-reexport') {
      assert.match(source, /^export \* from ['"][^'"]+['"];\n$/);
      assert.equal(source.split('\n').length, 2);
    } else {
      assert.equal(adapter.kind, 'test-config-clone');
      assert.match(source, /structuredClone\(DOMAIN_CONFIG\)/);
    }
    assert.equal(source.includes('/mvp/'), false, adapter.candidate);
  }
});

test('replacement test graph 的相对 import 只能落在声明节点和唯一 config projection', async () => {
  const [testLedger, domainLedger] = await Promise.all([
    JSON.parse(await readFile(`${RUNTIME}/domain-test-migration.json`, 'utf8')),
    JSON.parse(await readFile(`${RUNTIME}/domain-migration.json`, 'utf8')),
  ]);
  const copied = [
    ...testLedger.suites,
    ...testLedger.supportFiles,
    ...testLedger.testSources,
    ...testLedger.adapters,
  ].map(({ candidate }) => resolve(ROOT, candidate));
  const domain = domainLedger.files.map(({ candidate }) => resolve(ROOT, candidate));
  const configProjection = resolve(ROOT, 'mvp/src/config.js');
  const allowed = new Set([...copied, ...domain, configProjection]);
  const visited = new Set();
  const stack = [...copied];
  while (stack.length > 0) {
    const path = stack.pop();
    if (visited.has(path) || path === configProjection) continue;
    visited.add(path);
    for (const edge of await imports(path)) {
      if (!edge.startsWith('.')) continue;
      const target = resolve(dirname(path), edge);
      assert.equal(allowed.has(target), true, `${path} -> ${target}`);
      stack.push(target);
    }
  }
  assert.equal(visited.has(resolve(ROOT, 'flock-voice-engine/runtime/test/src/agent.js')), true);
  for (const path of domain) assert.equal(visited.has(path), true, path);
});
