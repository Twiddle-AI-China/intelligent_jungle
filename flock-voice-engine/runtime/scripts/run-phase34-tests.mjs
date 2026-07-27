import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const testRoot = fileURLToPath(new URL('test/', root));

function inventory(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...inventory(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

const files = inventory(testRoot).sort((left, right) => (
  relative(testRoot, left).localeCompare(relative(testRoot, right), 'en')
));
const normalized = files.map((path) => relative(testRoot, path).split(sep).join('/'));
for (const prefix of ['agents/', 'latent/', 'api/', 'protocol/', 'integration/', 'security/']) {
  if (!normalized.some((path) => path.startsWith(prefix))) {
    throw new Error(`PHASE34_TEST_PREFIX_EMPTY:${prefix}`);
  }
}
if (normalized.some((path) => path.startsWith('e2e/') || path.startsWith('fixtures/'))) {
  throw new Error('PHASE34_BROWSER_TEST_INVENTORY_INVALID');
}
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (run.error) throw run.error;
if (run.signal) throw new Error(`PHASE34_TEST_SIGNAL:${run.signal}`);
process.exit(run.status ?? 1);
