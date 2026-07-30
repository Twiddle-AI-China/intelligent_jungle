import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  decodePhase5FaultControlCompletion,
  encodePhase5FaultControlInstruction,
  encodePhase5FaultControlRequest,
  encodePhase5FaultControlResponse,
} from '../../src/acceptance/phase5-fault-control-protocol.js';
import {
  createPhase5ControllerSessionClient,
} from '../../tools/lib/phase5-controller-session-client.mjs';
import { canonicalJson } from '../../tools/lib/phase5-lease-evidence.mjs';

const line = (value) => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');

test('controller session relays only digest-bound fixed client instructions', async () => {
  const incoming = [line({
    schemaVersion: 1,
    kind: 'phase5-controller-session-admission',
    descriptor: {
      binding: {
      runId: '123e4567-e89b-42d3-a456-426614174000',
      challenge: 'a'.repeat(64),
        release: {
          releaseManifestSha256: 'b'.repeat(64),
          releaseRevision: 'c'.repeat(40),
          sourceManifestSha256: 'd'.repeat(64),
          audioArtifactSha256: 'e'.repeat(64),
        },
        geometry: { sampleRate: 44_100, blockFrames: 4_096, poolSize: 5,
          rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'] },
        profile: { clients: 4, slowClient: 4, durationMinutes: 30,
          speciesEndpoint: 'http://127.0.0.1:8081/v1', speciesModel: 'bird_agent' },
      },
      window: { startedAtMonotonicMs: 1000, endedAtMonotonicMs: 1801000,
        startedAtUnixMs: 2000, endedAtUnixMs: 1802000 },
    },
    clientCapabilities: Array.from({ length: 4 }, (_, index) => ({
      client: index + 1,
      clientIdentitySha256: String(index + 1).repeat(64),
      runtimeCapability: String.fromCharCode(97 + index).repeat(43),
      runtimeGeneration: 1,
      audioCapability: String.fromCharCode(101 + index).repeat(43),
      audioGeneration: 1,
    })),
  })];
  const action = Buffer.from('{"sequence":9}', 'utf8');
  incoming.push(encodePhase5FaultControlInstruction({
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction',
    sequence: 4,
    actionEventBase64: action.toString('base64'),
    runtimeCapability: 'z'.repeat(43),
  }));
  incoming.push(encodePhase5FaultControlResponse({
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance-response',
    sequence: 1,
    result: { eventBase64: Buffer.from('{}').toString('base64') },
  }));
  const sent = [];
  const handled = [];
  const client = createPhase5ControllerSessionClient({
    sendFrame: async (bytes) => sent.push(bytes),
    receiveFrame: async () => incoming.shift(),
    handleClientInstruction: async (value) => {
      handled.push(value.sequence);
      return true;
    },
  });
  const admitted = await client.receiveAdmission();
  assert.equal(admitted.clientCapabilities.length, 4);
  assert.equal(admitted.descriptor.binding.runId,
    '123e4567-e89b-42d3-a456-426614174000');
  const response = await client.sendRequestBytes(
    encodePhase5FaultControlRequest({
      schemaVersion: 1,
      kind: 'phase5-fault-control-advance',
      sequence: 1,
    }),
  );
  assert.equal(JSON.parse(response).sequence, 1);
  assert.deepEqual(handled, [4]);
  assert.equal(sent.length, 2);
  const completion = decodePhase5FaultControlCompletion(sent[1]);
  assert.equal(completion.actionEventSha256,
    createHash('sha256').update(action).digest('hex'));
});
