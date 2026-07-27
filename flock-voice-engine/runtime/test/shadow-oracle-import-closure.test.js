import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../', import.meta.url));
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const MODULE_SCRIPT_PATTERN = /<script\b[^>]*\btype\s*=\s*['"]module['"][^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;

async function imports(path) {
  const source = await readFile(path, 'utf8');
  if (path.endsWith('.html')) {
    return [...source.matchAll(MODULE_SCRIPT_PATTERN)].map((match) => match[1]);
  }
  const matches = [...source.matchAll(IMPORT_PATTERN)];
  let masked = source;
  for (const match of [...matches].reverse()) {
    masked = `${masked.slice(0, match.index)}${' '.repeat(match[0].length)}${masked.slice(match.index + match[0].length)}`;
  }
  for (const forbidden of [
    /\bimport\s*\(/,
    /\brequire\s*\(/,
    /\bcreateRequire\b/,
    /\beval\s*\(/,
  ]) assert.equal(forbidden.test(masked), false, `unresolved loader in ${path}: ${forbidden}`);
  return matches.map((match) => match[1] ?? match[2]);
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
    resolve(ROOT, 'mvp/src/runtime-client.js'),
    resolve(ROOT, 'mvp/index.html'),
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

test('shadow runner closure reaches candidate runtime only, never the MVP oracle', async () => {
  const entry = resolve(RUNTIME, 'src/shadow/shadow-runner.js');
  const graph = await closure([entry]);
  assert.equal(graph.has(entry), true);
  for (const path of graph) {
    assert.equal(path.endsWith('/mvp/eval/shadow-oracle.js'), false, path);
    if (!path.includes('/mvp/')) continue;
    assert.equal(path.endsWith('/mvp/src/config.js'), true, `undeclared runner MVP edge: ${path}`);
  }
  const direct = await imports(entry);
  assert.deepEqual(direct.sort(), [
    '../domain/simulation-checkpoint.js',
    '../simulation-runtime.js',
    '../world-session/world-session.js',
    './compare.js',
  ]);
});

test('real HTML module entry is pinned to the production main graph', async () => {
  assert.deepEqual(
    await imports(resolve(ROOT, 'mvp/index.html')),
    ['./src/main.js?v=20260722-roamer-sidebar-1'],
  );
});
