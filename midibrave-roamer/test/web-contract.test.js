import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const midi = readFileSync(new URL('../web/midi-input.js', import.meta.url), 'utf8');
const router = readFileSync(new URL('../web/input-router.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const sbatch = readFileSync(new URL('../deploy/roamer.sbatch', import.meta.url), 'utf8');

test('roamer is model-driven and converts its normalized cursor with map scale', () => {
  assert.match(app, /manifest\.models\.find/);
  assert.match(app, /cursor\.x \* scale/);
  assert.match(app, /compatibility\?\.polyphonyRows/);
  assert.doesNotMatch(app, /world|agent|season|sequence/i);
  assert.match(html, /NEURAL LATENT HOST/);
});

test('computer keyboard and Web MIDI drive the selected neural voice', () => {
  assert.match(app, /PolyphonicInputRouter/);
  assert.match(app, /PolyphonicVoiceAllocator/);
  assert.match(app, /fallbackEnabled: false/);
  assert.match(app, /navigator\.requestMIDIAccess/);
  assert.match(app, /input\.onmidimessage = handleMidiMessage/);
  assert.match(midi, /command === 0x90/);
  assert.match(midi, /command === 0x80/);
  assert.match(app, /COMPUTER_KEYS/);
  assert.match(midi, /kind: 'midi'/);
  assert.match(app, /kind: 'computer'/);
  assert.match(app, /MidiInputController/);
  assert.match(app, /voice\.hold\(action\.row, action\.midi, action\.velocity\)/);
  assert.match(app, /activateAutomatically\(false\)/);
  assert.match(app, /ensureMidiAccess/);
  assert.doesNotMatch(app, /await voice\.context\.resume/);
  assert.doesNotMatch(html, />Connect</);
  assert.doesNotMatch(html, />Enable MIDI</);
});

test('auto wander owns only latent motion and never injects a preview note', () => {
  const startInput = app.slice(
    app.indexOf('function startPlayableNote'),
    app.indexOf('function stopPlayableNote'),
  );
  const wanderClick = app.slice(
    app.indexOf("ui.wander.addEventListener('click'"),
    app.indexOf("window.addEventListener('keydown'"),
  );
  assert.doesNotMatch(app, /wander-preview/);
  assert.doesNotMatch(router, /wander-preview/);
  assert.doesNotMatch(wanderClick, /startPlayableNote/);
  assert.match(wanderClick, /wanderMotion\.reset/);
  assert.match(app, /wanderMotion\.step/);
  assert.match(html, /id="wander-speed"/);
  assert.match(html, /id="wander-turn"/);
  assert.match(app, /entry\.kind === 'computer'/);
  assert.match(midi, /entry\.kind === 'midi'/);
  assert.doesNotMatch(startInput, /stopWander\(\)/);
});

test('Spark deployment is both SLURM and Docker bounded', () => {
  assert.match(sbatch, /^#SBATCH --partition=gpu/m);
  assert.doesNotMatch(sbatch, /^#SBATCH --account=/m);
  assert.match(sbatch, /^#SBATCH --gres=gpu:1/m);
  assert.match(sbatch, /CUDA_VISIBLE_DEVICES:\?/);
  assert.match(sbatch, /MIDIBRAVE_CALIBRATION_ROOT:\?/);
  assert.match(sbatch, /exec docker run/);
  assert.match(sbatch, /--read-only/);
  assert.match(sbatch, /--skip-assemble/);
});
