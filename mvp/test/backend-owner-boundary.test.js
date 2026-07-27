import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

test('production entry is fixed to server owner and PCM-only browser playback', async () => {
  const html = await readFile(new URL('mvp/index.html', ROOT), 'utf8');
  assert.match(html, /src="\.\/src\/server-main\.js"/);
  for (const forbidden of ['./src/main.js', 'runtime-config.js', '/_client/voice-client.js']) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }

  const source = await readFile(new URL('mvp/src/server-main.js', ROOT), 'utf8');
  assert.equal(source.includes('createServerOwnedApp'), true);
  assert.equal(source.includes("from './pcm-player.js'"), true);
  for (const forbidden of [
    './world.js', './agent.js', './audio.js', './ecological-latent.js',
    './config.js', './sequence.js', '8081', '/decoder', 'OscillatorNode',
    'createOscillator', 'createBufferSource', 'createConvolver',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
