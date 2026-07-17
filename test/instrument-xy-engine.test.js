import assert from 'node:assert/strict';
import test from 'node:test';
import { createXYEngine, noteOff, noteOn, releaseXYTarget, setEngineControl, setXYTarget, snapshotXYEngine, stepXYEngine } from '../src/instrument/xy-engine.js';
import { replaySession, SessionRecorder } from '../src/instrument/session.js';

test('XY target is bounded while the eternal sound gate stays open', () => {
  const engine = createXYEngine();
  setXYTarget(engine, -4, 7, true);
  assert.deepEqual([engine.x, engine.y, engine.pointerActive], [0, 1, true]);
  assert.equal(engine.gate, true);
  assert.equal(engine.lastNote, 60);
  releaseXYTarget(engine);
  assert.equal(engine.pointerActive, false);
});

test('multiple keys select pitch and release returns to the eternal C4 carrier', () => {
  const engine = createXYEngine();
  assert.equal(noteOn(engine, 'a', 60, 0.4), 1);
  assert.equal(noteOn(engine, 'w', 61, 0.8), 1);
  assert.equal(engine.gate, true); assert.equal(engine.velocity, 0.8);
  assert.equal(engine.pitchSemitones, 1);
  noteOff(engine, 'w'); assert.equal(engine.gate, true); assert.equal(engine.pitchSemitones, 0);
  noteOff(engine, 'a'); assert.equal(engine.gate, true); assert.equal(engine.lastNote, 60); assert.equal(engine.pitchSemitones, 0);
  noteOn(engine, 'a', 72, 1); assert.equal(engine.gateSerial, 1);
});

test('trajectory controls are clamped and lifecycle control is absent', () => {
  const engine = createXYEngine();
  assert.equal(setEngineControl(engine, 'timbreRange', 99), 6);
  assert.equal(setEngineControl(engine, 'latentStep', 0), 0.005);
  assert.equal(setEngineControl(engine, 'maxDurationSeconds', 1), false);
  assert.equal(setEngineControl(engine, 'unknown', 1), false);
});

test('recorded XY and gate events replay deterministically', () => {
  const engine = createXYEngine(); const recorder = new SessionRecorder(engine);
  recorder.record(engine, 'xy', { x: 0.8, y: 0.2, active: true }); setXYTarget(engine, 0.8, 0.2, true);
  engine.relationState = [0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4]; recorder.record(engine, 'relations', { values: engine.relationState });
  stepXYEngine(engine, 0.5); recorder.record(engine, 'note-on', { id: 'a', note: 60, velocity: 0.7 }); noteOn(engine, 'a', 60, 0.7);
  stepXYEngine(engine, 0.5); recorder.record(engine, 'note-off', { id: 'a' }); noteOff(engine, 'a');
  assert.deepEqual(replaySession(recorder.export(), 1), snapshotXYEngine(engine));
});

test('the carrier and its age continue indefinitely without a lifecycle reset', () => {
  const engine = createXYEngine();
  noteOn(engine, 'a', 60, 1); noteOff(engine, 'a'); stepXYEngine(engine, 3600);
  assert.equal(engine.gate, true); assert.equal('lifecycleEndedSerial' in engine, false); assert.equal(engine.voiceAge, 3600); assert.equal(engine.heldNotes.size, 0);
});
