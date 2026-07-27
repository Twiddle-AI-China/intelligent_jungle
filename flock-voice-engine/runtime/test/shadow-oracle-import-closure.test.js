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

async function closure(entries) {
  const visited = new Set();
  const stack = entries.map((entry) => resolve(entry));
  while (stack.length > 0) {
    const path = stack.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    for (const edge of await imports(path)) {
      if (edge.startsWith('.')) stack.push(resolve(dirname(path), edge.split(/[?#]/, 1)[0]));
    }
  }
  return visited;
}

test('MVP oracle graph only reaches canonical provider-free domain', async () => {
  const entry = resolve(ROOT, 'mvp/eval/shadow-oracle.js');
  const graph = await closure([entry]);
  const allowed = new Set([
    entry,
    ...[
      'config.js', 'world.js', 'sequence.js', 'economy.js', 'harmony.js',
      'mapping.js', 'jungle.js', 'deterministic-conductor.js',
      'deterministic-rng.js', 'simulation-checkpoint.js',
      'master/policy.js', 'survival-actions.js',
    ].map((path) => resolve(ROOT, 'mvp/src', path)),
  ]);
  for (const path of graph) {
    assert.equal(allowed.has(path), true, `undeclared oracle edge: ${path}`);
    assert.equal(path.includes('/flock-voice-engine/runtime/'), false, path);
    assert.equal(path.endsWith('/mvp/src/agent.js'), false, path);
    const source = await readFile(path, 'utf8');
    for (const forbidden of [
      'AudioContext', 'WebSocket', 'fetch(',
      'voice-client', 'worklet', '8081',
    ]) assert.equal(source.includes(forbidden), false, `${path}: ${forbidden}`);
  }
});

test('production and candidate UI graphs cannot reach oracle or shadow helpers', async () => {
  const entries = [
    resolve(RUNTIME, 'src/index.js'),
    resolve(RUNTIME, 'src/simulation-runtime.js'),
    resolve(ROOT, 'mvp/src/main.js'),
  ];
  const graph = await closure(entries);
  for (const path of graph) {
    assert.equal(path.endsWith('/mvp/eval/shadow-oracle.js'), false, path);
    assert.equal(path.includes('/runtime/src/shadow/'), false, path);
  }
  const shadowFiles = (await readdir(resolve(RUNTIME, 'src/shadow')))
    .filter((name) => name.endsWith('.js'));
  assert.deepEqual(shadowFiles.sort(), ['canonicalize.js', 'compare.js', 'shadow-runner.js']);
});
