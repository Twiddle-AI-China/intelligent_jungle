import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('入口与潜空间子模块使用同一部署版本标识，避免新旧模块混载', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const main = await readFile(new URL('src/main.js', root), 'utf8');
  const version = '20260722-roamer-sidebar-1';
  assert.match(html, new RegExp(`src/main\\.js\\?v=${version}`));
  assert.match(main, new RegExp(`ui/latent-roamer\\.js\\?v=${version}`));
});
