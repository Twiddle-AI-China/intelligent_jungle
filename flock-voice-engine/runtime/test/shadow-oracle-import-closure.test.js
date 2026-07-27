import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../', import.meta.url));
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function javascriptImports(source, label) {
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
  ]) assert.equal(forbidden.test(masked), false, `unresolved loader in ${label}: ${forbidden}`);
  return matches.map((match) => match[1] ?? match[2]);
}

function attribute(source, name) {
  const match = source.match(new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function htmlImports(source, label) {
  const edges = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.toLowerCase().indexOf('<script', cursor);
    if (start < 0) break;
    const boundary = source[start + 7];
    if (boundary && !/[\s/>]/.test(boundary)) {
      cursor = start + 7;
      continue;
    }
    let quote = null;
    let tagEnd = start + 7;
    for (; tagEnd < source.length; tagEnd += 1) {
      const char = source[tagEnd];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    assert.notEqual(tagEnd, source.length, `unterminated script tag in ${label}`);
    const close = source.toLowerCase().indexOf('</script', tagEnd + 1);
    assert.notEqual(close, -1, `unterminated script body in ${label}`);
    const attributes = source.slice(start + 7, tagEnd);
    const src = attribute(attributes, 'src');
    if (src !== null) edges.push(src);
    else edges.push(...javascriptImports(source.slice(tagEnd + 1, close), `${label}#inline`));
    const closeEnd = source.indexOf('>', close + 8);
    assert.notEqual(closeEnd, -1, `unterminated script close in ${label}`);
    cursor = closeEnd + 1;
  }
  return edges;
}

async function imports(path) {
  const source = await readFile(path, 'utf8');
  return path.endsWith('.html')
    ? htmlImports(source, path)
    : javascriptImports(source, path);
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
    [
      './runtime-config.js',
      '/_client/voice-client.js',
      './src/main.js?v=20260722-roamer-sidebar-1',
    ],
  );
});

test('HTML closure sees reversed attributes and inline module imports', () => {
  assert.deepEqual(htmlImports(
    '<script src="./eval/shadow-oracle.js" type="module"></script>',
    'reversed.html',
  ), ['./eval/shadow-oracle.js']);
  assert.deepEqual(htmlImports(
    '<script type="module">import "./eval/shadow-oracle.js";</script>',
    'inline.html',
  ), ['./eval/shadow-oracle.js']);
});
