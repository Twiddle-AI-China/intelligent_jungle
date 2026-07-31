import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../', import.meta.url));
const EXTERNAL_BROWSER_ROUTES = new Set(['/_client/voice-client.js']);
const NODE_BARE_SPECIFIERS = new Set(['ws']);

function projectPath(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function pathIs(path, expected) {
  return projectPath(path) === expected;
}

function pathWithin(path, directory) {
  const value = projectPath(path);
  return value === directory || value.startsWith(`${directory}/`);
}

function javascriptTokens(source, label) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      assert.notEqual(end, -1, `unterminated comment in ${label}`);
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      let escaped = false;
      index += 1;
      for (; index < source.length; index += 1) {
        const current = source[index];
        if (escaped) {
          value += `\\${current}`;
          escaped = false;
          continue;
        }
        if (current === '\\') { escaped = true; continue; }
        if (current === quote) break;
        value += current;
      }
      assert.notEqual(index, source.length, `unterminated string in ${label}`);
      tokens.push({ type: 'string', value });
      index += 1;
      continue;
    }
    if (char === '`') {
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        if (escaped) { escaped = false; continue; }
        if (source[end] === '\\') { escaped = true; continue; }
        if (source[end] === '`') break;
      }
      assert.notEqual(end, source.length, `unterminated template in ${label}`);
      const template = source.slice(index, end + 1);
      assert.equal(/\b(?:import|export)\b/.test(template), false,
        `module syntax inside template is not allowed in ${label}`);
      tokens.push({ type: 'template', value: template });
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w$]/.test(source[end])) end += 1;
      tokens.push({ type: 'identifier', value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ type: 'punctuator', value: char });
    index += 1;
  }
  return tokens;
}

function moduleSpecifier(token, label) {
  assert.equal(token?.type, 'string', `nonliteral module specifier in ${label}`);
  assert.equal(token.value.includes('\\'), false, `escaped module specifier in ${label}`);
  return token.value;
}

function javascriptImports(source, label) {
  const tokens = javascriptTokens(source, label);
  const edges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier') continue;
    if (['require', 'createRequire', 'eval', 'Function'].includes(token.value)) {
      throw new Error(`forbidden loader identifier ${token.value} in ${label}`);
    }
    if (token.value === 'import' && tokens[index - 1]?.value !== '.') {
      const next = tokens[index + 1];
      if (next?.value === '.') continue;
      if (next?.value === '(') {
        assert.equal(tokens[index + 2]?.type, 'string', `nonliteral dynamic import in ${label}`);
        assert.equal(tokens[index + 3]?.value, ')', `dynamic import options are not allowed in ${label}`);
        edges.push(moduleSpecifier(tokens[index + 2], label));
      } else if (next?.type === 'string') {
        edges.push(moduleSpecifier(next, label));
      } else {
        let cursor = index + 1;
        while (cursor < tokens.length && tokens[cursor].value !== ';') {
          if (tokens[cursor].value === 'from') break;
          cursor += 1;
        }
        assert.equal(tokens[cursor]?.value, 'from', `unresolved static import in ${label}`);
        assert.equal(tokens[cursor + 1]?.type, 'string', `nonliteral static import in ${label}`);
        edges.push(moduleSpecifier(tokens[cursor + 1], label));
      }
    }
    if (token.value === 'export' && tokens[index - 1]?.value !== '.') {
      if (!['*', '{'].includes(tokens[index + 1]?.value)) continue;
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor].value !== ';') {
        if (tokens[cursor].value === 'from') {
          assert.equal(tokens[cursor + 1]?.type, 'string', `nonliteral export edge in ${label}`);
          edges.push(moduleSpecifier(tokens[cursor + 1], label));
          break;
        }
        cursor += 1;
      }
    }
  }
  return edges;
}

function attribute(source, name) {
  const match = source.match(new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function htmlImports(source, label) {
  const handlers = [...source.matchAll(
    /\s(on[a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  )];
  for (const match of handlers) {
    assert.deepEqual(
      [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]],
      ['onerror', 'void 0'],
      `undeclared executable HTML attribute in ${label}`,
    );
  }
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
    assert.notEqual(attribute(attributes, 'type')?.toLowerCase(), 'importmap',
      `import maps are not allowed in ${label}`);
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

function resolveLocalEdge(importer, edge) {
  const clean = edge.split(/[?#]/, 1)[0];
  if (EXTERNAL_BROWSER_ROUTES.has(clean)) return null;
  if (clean.startsWith('.')) return resolve(dirname(importer), clean);
  if (clean.startsWith('/mvp/')) return resolve(ROOT, clean.slice(1));
  if (clean.startsWith('/')) return resolve(ROOT, 'mvp', clean.slice(1));
  const browserImporter = pathWithin(importer, 'mvp');
  if (browserImporter) throw new Error(`unresolved browser import ${edge} from ${importer}`);
  if (clean.startsWith('node:') || NODE_BARE_SPECIFIERS.has(clean)) return null;
  throw new Error(`undeclared Node import ${edge} from ${importer}`);
}

async function closure(entries) {
  const visited = new Set();
  const stack = entries.map((entry) => resolve(entry));
  while (stack.length > 0) {
    const path = stack.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    for (const edge of await imports(path)) {
      const target = resolveLocalEdge(path, edge);
      if (target !== null) stack.push(target);
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
    assert.equal(pathWithin(path, 'flock-voice-engine/runtime'), false, path);
    assert.equal(pathIs(path, 'mvp/src/agent.js'), false, path);
    const source = await readFile(path, 'utf8');
    for (const forbidden of [
      'AudioContext', 'WebSocket', 'fetch(',
      'voice-client', 'worklet', '8081',
    ]) assert.equal(source.includes(forbidden), false, `${path}: ${forbidden}`);
  }
});

test('production UI graph reaches only the fixed server-owned browser composition', async () => {
  const graph = await closure([
    resolve(ROOT, 'mvp/index.html'),
  ]);
  assert.equal(graph.has(resolve(ROOT, 'mvp/src/server-main.js')), true);
  assert.equal(graph.has(resolve(ROOT, 'mvp/src/main.js')), false);
  assert.equal(graph.has(resolve(ROOT, 'mvp/src/runtime-client.js')), true);
  assert.equal(graph.has(resolve(ROOT, 'mvp/src/pcm-player.js')), true);
  for (const path of graph) {
    assert.equal(pathIs(path, 'mvp/eval/shadow-oracle.js'), false, path);
    assert.equal(pathWithin(path, 'flock-voice-engine/runtime/src/shadow'), false, path);
    assert.equal(pathWithin(path, 'flock-voice-engine/runtime/src'), false, path);
    assert.equal(pathWithin(path, 'flock-voice-engine/runtime/test/fixtures/candidate-ui'), false, path);
  }
});

function assertCandidateGraph(graph) {
  const allowed = new Set([
    resolve(RUNTIME, 'test/fixtures/candidate-ui/candidate-main.js'),
    ...[
      'runtime-client.js', 'renderer.js', 'scene-layout.js',
      'view-config.js', 'view-sequence.js', 'ui/latent-roamer.js',
    ].map((path) => resolve(ROOT, 'mvp/src', path)),
  ]);
  for (const path of graph) {
    assert.equal(allowed.has(path), true, `undeclared candidate edge: ${path}`);
  }
}

test('candidate graph is exactly the declared render and runtime-client surface', async () => {
  const entry = resolve(RUNTIME, 'test/fixtures/candidate-ui/candidate-main.js');
  const graph = await closure([entry]);
  assertCandidateGraph(graph);
  assert.equal(graph.has(resolve(ROOT, 'mvp/src/runtime-client.js')), true);
  assert.equal(graph.has(resolve(ROOT, 'mvp/src/renderer.js')), true);

  const maliciousEdges = javascriptImports(
    "import { attachPipelineConductor } from '/mvp/src/agent.js';",
    'negative-agent-owner.js',
  );
  assert.deepEqual(maliciousEdges, ['/mvp/src/agent.js']);
  assert.throws(
    () => assertCandidateGraph(new Set([
      entry,
      resolveLocalEdge(entry, maliciousEdges[0]),
    ])),
    /undeclared candidate edge: .*agent\.js/,
  );
});

test('candidate client and Node production graphs cannot reach test shadow helpers', async () => {
  const graph = await closure([
    resolve(RUNTIME, 'src/index.js'),
    resolve(RUNTIME, 'src/simulation-runtime.js'),
    resolve(ROOT, 'mvp/src/runtime-client.js'),
  ]);
  for (const path of graph) {
    assert.equal(pathIs(path, 'mvp/eval/shadow-oracle.js'), false, path);
    assert.equal(pathWithin(path, 'flock-voice-engine/runtime/src/shadow'), false, path);
    assert.equal(pathWithin(path, 'flock-voice-engine/runtime/test/fixtures/candidate-ui'), false, path);
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
    assert.equal(pathIs(path, 'mvp/eval/shadow-oracle.js'), false, path);
    if (!pathWithin(path, 'mvp')) continue;
    assert.equal(pathIs(path, 'mvp/src/config.js'), true, `undeclared runner MVP edge: ${path}`);
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
    ['./src/server-main.js?v=faf5635537ec'],
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
  assert.throws(
    () => htmlImports('<body onload="import(\'/eval/shadow-oracle.js\')">', 'handler.html'),
    /undeclared executable HTML attribute/,
  );
  assert.throws(
    () => htmlImports('<script type="importmap">{}</script>', 'map.html'),
    /import maps are not allowed/,
  );
});

test('browser root-relative imports resolve from the pinned MVP web root', () => {
  const importer = resolve(ROOT, 'mvp/src/main.js');
  assert.equal(
    resolveLocalEdge(importer, '/eval/shadow-oracle.js'),
    resolve(ROOT, 'mvp/eval/shadow-oracle.js'),
  );
  assert.throws(() => resolveLocalEdge(importer, 'oracle'), /unresolved browser import/);
  assert.throws(
    () => resolveLocalEdge(importer, 'https://example.test/oracle.js'),
    /unresolved browser import/,
  );
});

test('JavaScript lexer sees comments between module tokens', () => {
  assert.deepEqual(
    javascriptImports('import/* legal comment */"/eval/shadow-oracle.js";', 'comment.js'),
    ['/eval/shadow-oracle.js'],
  );
  for (const source of [
    'eval?.(\'import("/eval/shadow-oracle.js")\')',
    '(0, eval)(\'import("/eval/shadow-oracle.js")\')',
    'Function(\'return import("/eval/shadow-oracle.js")\')()',
  ]) assert.throws(
    () => javascriptImports(source, 'indirect-loader.js'),
    /forbidden loader identifier/,
  );
});
