import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../config/models.json', import.meta.url)));

test('model manifest binds every model to its own immutable runtime assets', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.artifactRelease.baseUrl, /^https:\/\//);
  assert.equal(manifest.models.length, 4);
  assert.equal(new Set(manifest.models.map((model) => model.id)).size, manifest.models.length);
  for (const model of manifest.models) {
    assert.match(model.id, /^[a-z0-9-]+$/);
    assert.ok(['midibrave-v2', 'trajectorybrave-v1'].includes(model.engine));
    assert.match(model.checkpoint.filename, /\.pt$/);
    assert.ok(Number.isSafeInteger(model.checkpoint.bytes) && model.checkpoint.bytes > 0);
    assert.match(model.checkpoint.sha256, /^[0-9a-f]{64}$/);
    assert.match(model.map, /\.json$/);
    assert.match(model.calibration, /\.npy$/);
    assert.ok(Number.isSafeInteger(model.compatibility.row));
    assert.equal(model.compatibility.polyphonyRows.length, 4);
    assert.equal(new Set(model.compatibility.polyphonyRows).size, 4);
    assert.equal(model.compatibility.polyphonyRows[0], model.compatibility.row);
    assert.ok(model.compatibility.polyphonyRows.every(Number.isSafeInteger));
  }
});
test('public model identity is independent from Jungle species names', () => {
  for (const model of manifest.models) {
    assert.doesNotMatch(model.id, /bass|lead|pad|pluck|melody|texture/);
    assert.doesNotMatch(model.displayName, /bass|lead|pad|pluck|melody|texture/i);
  }
});
