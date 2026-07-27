import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../', import.meta.url));
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function imports(path) {
  const source = await readFile(path, 'utf8');
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2]);
}

test('exact-copy production modules 不得直接跨回 mvp', async () => {
  const ledger = JSON.parse(await readFile(`${RUNTIME}/domain-migration.json`, 'utf8'));
  const declared = new Set(ledger.files.map(({ candidate }) => resolve(ROOT, candidate)));
  for (const item of ledger.files) {
    const candidatePath = `${ROOT}/${item.candidate}`;
    const edges = await imports(candidatePath);
    const mvpEdges = edges.filter((edge) => edge.includes('mvp/'));
    if (item.mode === 'projection') {
      assert.deepEqual(mvpEdges, ['../../../../mvp/src/config.js']);
    } else {
      assert.deepEqual(mvpEdges, [], item.candidate);
    }
    for (const edge of edges.filter((value) => value.startsWith('.'))) {
      const target = resolve(dirname(candidatePath), edge);
      if (target.includes('/runtime/src/domain/')) {
        assert.equal(declared.has(target), true, `${item.candidate} -> ${edge}`);
      }
    }
  }
});

test('simulation runtime production closure 不可到达 browser/provider/audio endpoint', async () => {
  const entry = `${RUNTIME}/src/simulation-runtime.js`;
  const ledger = JSON.parse(await readFile(`${RUNTIME}/domain-migration.json`, 'utf8'));
  const domainCandidates = ledger.files.map(({ candidate }) => resolve(ROOT, candidate));
  const domainDirectory = resolve(RUNTIME, 'src/domain');
  const actualDomainFiles = (await readdir(domainDirectory, { recursive: true }))
    .filter((path) => path.endsWith('.js'))
    .map((path) => resolve(domainDirectory, path))
    .sort();
  assert.deepEqual(actualDomainFiles, [...domainCandidates].sort());
  const configProjection = resolve(ROOT, 'mvp/src/config.js');
  const allowed = new Set([
    resolve(entry),
    resolve(RUNTIME, 'src/agents/status-projector.js'),
    resolve(RUNTIME, 'src/audio/null-audio-sink.js'),
    ...domainCandidates,
    configProjection,
  ]);
  const visited = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const path = stack.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, 'utf8');
    for (const forbidden of [
      'AudioContext', 'WebSocket', 'fetch(', '/decoder', '/api/v1/audio',
      '8081', 'voice-client', 'worklet',
    ]) assert.equal(source.includes(forbidden), false, `${path}: ${forbidden}`);
    for (const edge of await imports(path)) {
      if (!edge.startsWith('.')) continue;
      const resolved = resolve(dirname(path), edge);
      assert.equal(allowed.has(resolved), true, `undeclared production edge: ${path} -> ${resolved}`);
      if (resolved.includes('/mvp/')
        && resolved !== configProjection) {
        assert.fail(`undeclared MVP edge: ${path} -> ${resolved}`);
      }
      if (resolved !== configProjection) stack.push(resolved);
    }
  }
});
