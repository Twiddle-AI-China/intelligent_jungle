import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('replacement test ledger 完整、无重复且所有 copy 字节一致', async () => {
  const ledger = JSON.parse(await readFile(`${RUNTIME}/domain-test-migration.json`, 'utf8'));
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.normalization, 'none-byte-for-byte');
  assert.equal(ledger.suites.length, 18);
  assert.equal(ledger.supportFiles.length, 4);
  assert.equal(ledger.testSources.length, 1);
  assert.equal(ledger.adapters.length, 12);

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
