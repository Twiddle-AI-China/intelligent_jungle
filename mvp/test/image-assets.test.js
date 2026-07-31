import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const LEGACY_RASTER = /\.(?:png|jpe?g|gif)$/i;
const WEBP = /\.webp$/i;
const WEBP_BUDGET_BYTES = 10 * 1024 * 1024;

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return nested.flat();
}

test('production image assets use WebP and remain within the first-load budget', async () => {
  const files = await filesBelow(root);
  const legacy = files.filter((file) => LEGACY_RASTER.test(file));
  assert.deepEqual(legacy, []);

  const webp = files.filter((file) => WEBP.test(file));
  assert.equal(webp.length, 51);
  const totalBytes = (await Promise.all(webp.map(async (file) => (await stat(file)).size)))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(totalBytes <= WEBP_BUDGET_BYTES, `${totalBytes} exceeds ${WEBP_BUDGET_BYTES}`);
});
