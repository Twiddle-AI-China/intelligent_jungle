import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../tools/soak-phase5.mjs', import.meta.url), 'utf8',
);

test('v2 soak is raw-only and has no controller-output authority', () => {
  for (const forbidden of [
    /acceptance\.json/u,
    /phase5-summary\.json/u,
    /capture_machine_attestation/u,
    /capture-and-attest-local/u,
    /docker\s+(?:stop|restart|rm)/u,
    /127\.0\.0\.1:8090/u,
    /rm\s*\(/u,
    /rename\s*\(/u,
  ]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /createPhase5ControllerFdTransport/u);
  assert.match(source, /createPhase5SoakOrchestrator/u);
  assert.match(source, /writePhase5RawTempDirectory/u);
});

test('controller capability is inherited as an fd and never accepted in argv', () => {
  assert.match(source, /FLOCK_PHASE5_CONTROLLER_FD/u);
  assert.doesNotMatch(source, /controller-fd/u);
  assert.doesNotMatch(source, /capability.*parseArgs|parseArgs.*capability/u);
});

test('the CLI owns exactly the raw inputs and private temporary directory', () => {
  for (const name of [
    'temporary-evidence', 'phase5-e2e', 'lease-evidence',
    'production-graph', 'production-attestation',
    'listening-checklist', 'equivalence',
  ]) assert.match(source, new RegExp(`'${name}'`, 'u'));
  for (const removed of [
    'duration-minutes', 'slow-client', 'species-model',
    'staging-attestation', 'output', 'operator',
  ]) assert.doesNotMatch(source, new RegExp(`'${removed}'`, 'u'));
});
