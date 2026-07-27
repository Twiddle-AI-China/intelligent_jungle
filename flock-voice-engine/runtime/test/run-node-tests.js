import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('./', import.meta.url));

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files.sort();
}

const testFiles = await discover(testRoot);
if (testFiles.length === 0) throw new Error('NO_RUNTIME_NODE_TESTS');

const child = spawn(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});
child.once('error', (error) => { throw error; });
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
