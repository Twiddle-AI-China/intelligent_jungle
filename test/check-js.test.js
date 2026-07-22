import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
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
