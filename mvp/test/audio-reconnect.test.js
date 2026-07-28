import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production composition delegates reconnect exclusively to protocol clients', async () => {
  const source = await readFile(new URL('../src/server-main.js', import.meta.url), 'utf8');
  assert.equal(source.includes('setInterval'), false);
  assert.equal(source.includes('setTimeout'), false);
  assert.doesNotMatch(source, /fetch\s*\(\s*['"]\/api\/v1\/audio/);
  assert.match(source, /createRuntimeClient\s*\(/);
  assert.match(source, /createPcmPlayer\s*\(/);
});
