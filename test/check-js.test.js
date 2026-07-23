import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildJavaScriptCheckPlan,
  collectClassicJavaScriptFiles,
  collectInlineScripts,
  collectJavaScriptFiles,
  collectLocalJavaScriptReferences,
  checkInlineScripts,
  checkJavaScriptFiles,
} from '../tools/check-js.mjs';

test('递归发现 js/mjs 并稳定排序', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-'));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'z.js'), 'export const z = 1;\n');
  writeFileSync(join(root, 'nested', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'nested', 'ignore.txt'), 'not javascript\n');
  assert.deepEqual(
    collectJavaScriptFiles([root]).map((file) => file.slice(root.length + 1).replaceAll('\\', '/')),
    ['nested/a.mjs', 'z.js'],
  );
});

test('语法错误返回失败文件，合法文件通过', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-'));
  const good = join(root, 'good.js');
  const bad = join(root, 'bad.js');
  writeFileSync(good, 'const good = true;\n');
  writeFileSync(bad, 'const = ;\n');
  assert.deepEqual(checkJavaScriptFiles([good]), []);
  assert.deepEqual(checkJavaScriptFiles([bad]), [bad]);
});

test('检查 canonical legacy HTML 的内联脚本并忽略 src 脚本', () => {
  const validRoot = mkdtempSync(join(tmpdir(), 'check-inline-valid-'));
  const invalidRoot = mkdtempSync(join(tmpdir(), 'check-inline-invalid-'));
  writeFileSync(
    join(validRoot, 'valid.html'),
    '<script src="external.js"></script><script>const valid = true;</script>\n',
  );
  writeFileSync(join(invalidRoot, 'invalid.html'), '<script>const = ;</script>\n');
  const valid = collectInlineScripts([validRoot]);
  const invalid = collectInlineScripts([invalidRoot]);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 1);
  assert.deepEqual(checkInlineScripts(valid), []);
  assert.deepEqual(checkInlineScripts(invalid), [invalid[0].label]);
});

test('仅按真实属性名识别 src/type 并支持无引号 type', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-inline-attributes-'));
  writeFileSync(
    join(root, 'attributes.html'),
    [
      '<script data-src="not-external.js">const dataSrc = true;</script>',
      '<script data-note="contains src=inside-value">const valueText = true;</script>',
      '<script data-type="application/json">const dataType = true;</script>',
      '<script type=application/json>{"ignored": true}</script>',
    ].join('\n'),
  );

  assert.deepEqual(
    collectInlineScripts([root]).map((script) => script.source.trim()),
    [
      'const dataSrc = true;',
      'const valueText = true;',
      'const dataType = true;',
    ],
  );
});

test('classic 模式拒绝顶层 await，module/worklet 模式允许', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-modes-'));
  const classic = join(root, 'classic.js');
  const module = join(root, 'module.js');
  const worklet = join(root, 'worklet.js');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(classic, 'await Promise.resolve();\n');
  writeFileSync(module, 'await Promise.resolve();\n');
  writeFileSync(worklet, 'await Promise.resolve(); registerProcessor("pcm", class {});\n');

  assert.deepEqual(
    checkJavaScriptFiles([classic], { classicFiles: new Set([classic]) }),
    [classic],
  );
  assert.deepEqual(checkJavaScriptFiles([module, worklet]), []);
});

test('从 HTML 真实外链引用推导 classic 文件集合', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-html-modes-'));
  const html = join(root, 'index.html');
  const classic = join(root, 'classic.js');
  writeFileSync(
    html,
    [
      '<script src="./classic.js" data-type="module"></script>',
      '<script src="./module.js" type=module></script>',
      '<script src="./data.js" type=application/json></script>',
      '<script data-src="./decoy.js">const inline = true;</script>',
    ].join('\n'),
  );

  assert.deepEqual(collectClassicJavaScriptFiles([root]), [classic]);
});

test('CLI 从非仓库 cwd 启动时仍检查仓库根目录并打印真实计数', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const checkerPath = join(repoRoot, 'tools', 'check-js.mjs');
  const clientRoot = join(repoRoot, 'flock-voice-engine', 'client');
  const htmlRoots = [join(repoRoot, 'index.html'), join(repoRoot, 'mvp', 'index.html'), clientRoot];
  const expectedFiles = buildJavaScriptCheckPlan(
    [join(repoRoot, 'src'), join(repoRoot, 'mvp', 'src'), clientRoot],
    htmlRoots,
  ).files.length;
  const expectedInline = collectInlineScripts(htmlRoots).length;
  const elsewhere = mkdtempSync(join(tmpdir(), 'check-js-cwd-'));

  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: elsewhere,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `checked ${expectedFiles} JavaScript files and ${expectedInline} inline scripts\n`,
  );
});

test('script 开始标签中的 quoted > 不截断属性或源码', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-script-tag-quotes-'));
  const classic = join(root, 'classic.js');
  writeFileSync(
    join(root, 'index.html'),
    [
      '<script data-note="x > y">const inline = true;</script>',
      '<script data-note="x > y" src="./classic.js"></script>',
    ].join('\n'),
  );

  assert.deepEqual(
    collectInlineScripts([root]).map((script) => script.source.trim()),
    ['const inline = true;'],
  );
  assert.deepEqual(collectClassicJavaScriptFiles([root]), [classic]);
});

test('script scanner 只接受真实标签名边界并跳过 HTML comment', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-script-tag-boundary-'));
  writeFileSync(
    join(root, 'index.html'),
    [
      '<!-- <script>const commented = true;</script> -->',
      '<script-foo>const pseudo = true;</script-foo>',
      '<script>const real = true;</script>',
    ].join('\n'),
  );

  assert.deepEqual(
    collectInlineScripts([root]).map((script) => script.source.trim()),
    ['const real = true;'],
  );
});

test('script scanner 跳过其它标签 quoted 属性中的伪 script', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-script-in-attribute-'));
  writeFileSync(
    join(root, 'index.html'),
    [
      '<div data-note="<script>const decoy = true;</script>"></div>',
      '<script>const real = true;</script>',
    ].join('\n'),
  );

  assert.deepEqual(
    collectInlineScripts([root]).map((script) => script.source.trim()),
    ['const real = true;'],
  );
});

test('无 script 的 HTML 返回空集合', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-no-script-'));
  writeFileSync(join(root, 'index.html'), '<div data-note="plain">no scripts</div>\n');
  writeFileSync(
    join(root, 'unterminated-comment.html'),
    '<!-- <script>const commented = true;</script>\n',
  );

  assert.deepEqual(collectInlineScripts([root]), []);
  assert.deepEqual(collectClassicJavaScriptFiles([root]), []);
});

test('classic collector 忽略非本地相对 URL 且不产生平台路径异常', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-classic-urls-'));
  const local = join(root, 'local.js');
  writeFileSync(
    join(root, 'index.html'),
    [
      '<script src="//cdn.example/x.js"></script>',
      '<script src="/server-root.js"></script>',
      '<script src="https://cdn.example/x.js"></script>',
      '<script src="data:text/javascript,alert(1)"></script>',
      '<script src="./local.js"></script>',
    ].join('\n'),
  );

  assert.deepEqual(collectClassicJavaScriptFiles([root]), [local]);
});

test('外部 classic 使用 browser Script grammar 而非 CommonJS wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-browser-script-'));
  const topLevelReturn = join(root, 'return.js');
  const newTarget = join(root, 'new-target.js');
  const commonJsNames = join(root, 'commonjs-names.js');
  writeFileSync(topLevelReturn, 'return;\n');
  writeFileSync(newTarget, 'new.target;\n');
  writeFileSync(commonJsNames, 'let module; let exports;\n');
  const files = [topLevelReturn, newTarget, commonJsNames];

  assert.deepEqual(
    checkJavaScriptFiles(files, { classicFiles: new Set(files) }),
    [topLevelReturn, newTarget],
  );
});

test('内联 classic 与外部 classic 共用 browser Script grammar', () => {
  const scripts = [
    { label: 'inline-return', source: 'return;\n', module: false },
    { label: 'inline-new-target', source: 'new.target;\n', module: false },
    { label: 'inline-commonjs-names', source: 'let module; let exports;\n', module: false },
    { label: 'inline-module', source: 'await Promise.resolve();\n', module: true },
  ];

  assert.deepEqual(
    checkInlineScripts(scripts),
    ['inline-return', 'inline-new-target'],
  );
});

test('CLI 经文件 symlink 启动时按 realpath 识别入口和仓库根', (context) => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const checkerPath = join(repoRoot, 'tools', 'check-js.mjs');
  const clientRoot = join(repoRoot, 'flock-voice-engine', 'client');
  const linkRoot = mkdtempSync(join(tmpdir(), 'check-js-symlink-'));
  const linkPath = join(linkRoot, 'check-js-link.mjs');
  try {
    symlinkSync(checkerPath, linkPath, 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip(`当前平台不允许创建文件 symlink: ${error.code}`);
      return;
    }
    throw error;
  }

  const htmlRoots = [join(repoRoot, 'index.html'), join(repoRoot, 'mvp', 'index.html'), clientRoot];
  const expectedFiles = buildJavaScriptCheckPlan(
    [join(repoRoot, 'src'), join(repoRoot, 'mvp', 'src'), clientRoot],
    htmlRoots,
  ).files.length;
  const expectedInline = collectInlineScripts(htmlRoots).length;
  const result = spawnSync(process.execPath, [linkPath], {
    cwd: linkRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `checked ${expectedFiles} JavaScript files and ${expectedInline} inline scripts\n`,
  );
});

test('canonical HTML 本地 active external JS 形成去重且带 parse goal 的引用事实', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const references = collectLocalJavaScriptReferences([
    join(repoRoot, 'index.html'),
    join(repoRoot, 'mvp', 'index.html'),
    join(repoRoot, 'flock-voice-engine', 'client'),
  ]);
  const expected = [
    { path: join(repoRoot, 'src', 'app.js'), module: true },
    { path: join(repoRoot, 'mvp', 'runtime-config.js'), module: false },
    { path: join(repoRoot, 'mvp', 'src', 'main.js'), module: true },
    { path: join(repoRoot, 'flock-voice-engine', 'client', 'voice-client.js'), module: false },
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'));

  assert.deepEqual(references, expected);
});

test('最终检查计划合并源码目录与 canonical HTML active refs', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const clientRoot = join(repoRoot, 'flock-voice-engine', 'client');
  const runtimeConfig = join(repoRoot, 'mvp', 'runtime-config.js');
  const app = join(repoRoot, 'src', 'app.js');
  const plan = buildJavaScriptCheckPlan(
    [join(repoRoot, 'src'), join(repoRoot, 'mvp', 'src'), clientRoot],
    [join(repoRoot, 'index.html'), join(repoRoot, 'mvp', 'index.html'), clientRoot],
  );

  assert.equal(plan.files.length, 46);
  assert.equal(plan.files.filter((file) => file === app).length, 1);
  assert.equal(plan.files.includes(runtimeConfig), true);
  assert.equal(plan.classicFiles.has(runtimeConfig), true);
  assert.equal(plan.classicFiles.has(join(repoRoot, 'mvp', 'src', 'main.js')), false);
});

test('目录外 HTML 引用进入组合门禁并按 classic/module goal 检查', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-plan-'));
  const sourceRoot = join(root, 'src');
  const html = join(root, 'index.html');
  const sourceModule = join(sourceRoot, 'source.js');
  const activeClassic = join(root, 'active-classic.js');
  const activeModule = join(root, 'active-module.js');
  mkdirSync(sourceRoot);
  writeFileSync(sourceModule, 'export const source = true;\n');
  writeFileSync(activeClassic, 'return;\n');
  writeFileSync(activeModule, 'await Promise.resolve();\n');
  writeFileSync(
    html,
    [
      '<script src="./active-classic.js"></script>',
      '<script type=module src="./active-module.js"></script>',
    ].join('\n'),
  );

  const plan = buildJavaScriptCheckPlan([sourceRoot], [html]);
  assert.deepEqual(plan.files, [activeClassic, activeModule, sourceModule].sort());
  assert.deepEqual([...plan.classicFiles], [activeClassic]);
  assert.deepEqual(
    checkJavaScriptFiles(plan.files, { classicFiles: plan.classicFiles }),
    [activeClassic],
  );
});
