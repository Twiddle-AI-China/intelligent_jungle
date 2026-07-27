import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('生产入口固定为 server-owned graph，不混载历史潜空间入口', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const main = await readFile(new URL('src/server-main.js', root), 'utf8');
  assert.match(html, /src\/server-main\.js/);
  assert.equal(html.includes('src/main.js'), false);
  assert.match(main, /ui\/latent-roamer\.js/);
  assert.equal(main.includes('latent-roamer-legacy.js'), false);
});
