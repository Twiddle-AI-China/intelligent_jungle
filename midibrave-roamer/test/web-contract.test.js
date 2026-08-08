import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const sbatch = readFileSync(new URL('../deploy/roamer.sbatch', import.meta.url), 'utf8');

test('roamer is model-driven and converts its normalized cursor with map scale', () => {
  assert.match(app, /manifest\.models\.find/);
  assert.match(app, /cursor\.x \* scale/);
  assert.match(app, /compatibility\?\.row/);
  assert.doesNotMatch(app, /world|agent|season|sequence/i);
  assert.match(html, /NEURAL LATENT HOST/);
});

test('computer keyboard and Web MIDI drive the selected neural voice', () => {
  assert.match(app, /fallbackEnabled: false/);
  assert.match(app, /navigator\.requestMIDIAccess/);
  assert.match(app, /input\.onmidimessage = handleMidiMessage/);
  assert.match(app, /command === 0x90/);
  assert.match(app, /command === 0x80/);
  assert.match(app, /COMPUTER_KEYS/);
  assert.match(app, /voice\.hold\(active\.row, active\.midi, active\.velocity\)/);
  assert.match(app, /voice\.release\(soundingNote\.row\)/);
  assert.match(html, /Enable MIDI/);
});

test('Spark deployment is both SLURM and Docker bounded', () => {
  assert.match(sbatch, /^#SBATCH --partition=gpu/m);
  assert.match(sbatch, /^#SBATCH --account=jnzhang/m);
  assert.match(sbatch, /^#SBATCH --gres=gpu:1/m);
  assert.match(sbatch, /CUDA_VISIBLE_DEVICES:\?/);
  assert.match(sbatch, /MIDIBRAVE_CALIBRATION_ROOT:\?/);
  assert.match(sbatch, /exec docker run/);
  assert.match(sbatch, /--read-only/);
  assert.match(sbatch, /--skip-assemble/);
});
