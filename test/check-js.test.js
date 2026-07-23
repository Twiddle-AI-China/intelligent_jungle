import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectClassicJavaScriptFiles,
  collectInlineScripts,
  collectJavaScriptFiles,
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
  const expectedFiles = collectJavaScriptFiles([
    join(repoRoot, 'src'),
    join(repoRoot, 'mvp', 'src'),
    clientRoot,
  ]).length;
  const expectedInline = collectInlineScripts([clientRoot]).length;
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
