import assert from 'node:assert/strict';
import test from 'node:test';

import {
  transportEventSha256,
} from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  projectPhase5ClientObservationsTransport,
} from '../../tools/lib/phase5-fault-transport-projection.mjs';
import {
  validatePhase5FaultEvidenceWithClientProjection,
} from '../../tools/lib/phase5-fault-validation.mjs';
import {
  signedFixture,
} from './phase5-fault-validation-fixture.js';

const PROJECTION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'window',
  'runtimeOpens',
  'audioLifecycle',
  'slowClient',
  'discontinuities',
]);

function receipt(event) {
  return {
    connectionGeneration: event.payload.generation,
    atMonotonicMs: event.atMonotonicMs,
    atUnixMs: event.atUnixMs,
    transportSequence: event.sequence,
    transportEventSha256: transportEventSha256(event),
  };
}

test('pure projector stays neutral while mapping the exact transport contract', () => {
  const { evidence } = signedFixture();
  const projection =
    projectPhase5ClientObservationsTransport(evidence);

  assert.deepEqual(Object.keys(projection), PROJECTION_FIELDS);
  assert.equal(projection.schemaVersion, 1);
  assert.equal(
    projection.kind,
    'phase5-client-observations-transport-projection',
  );
  assert.deepEqual(
    {
      runId: projection.runId,
      challenge: projection.challenge,
      release: projection.release,
      geometry: projection.geometry,
      profile: projection.profile,
      window: projection.window,
    },
    {
      runId: evidence.runId,
      challenge: evidence.challenge,
      release: evidence.release,
      geometry: evidence.geometry,
      profile: evidence.profile,
      window: evidence.window,
    },
  );

  const runtimeOpens = evidence.transportEvents
    .filter(({ type }) => type === 'runtime.open')
    .map((event) => ({
      client: event.client,
      connectionGeneration: event.payload.generation,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      mode: event.payload.mode,
      clientIdentitySha256: event.payload.clientIdentitySha256,
    }));
  assert.deepEqual(projection.runtimeOpens, runtimeOpens);

  const audioLifecycle = evidence.transportEvents
    .filter(({ type }) => (
      type === 'audio.open' || type === 'audio.close'
    ))
    .map((event) => ({
      client: event.client,
      connectionGeneration: event.payload.generation,
      type: event.type,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      payload: event.type === 'audio.open'
        ? {}
        : {
          code: event.payload.code,
          reason: event.payload.reason,
        },
    }));
  assert.deepEqual(projection.audioLifecycle, audioLifecycle);

  const pause = evidence.transportEvents.find((event) => (
    event.type === 'audio.pause' && event.client === 4
  ));
  const resume = evidence.transportEvents.find((event) => (
    event.type === 'audio.resume' && event.client === 4
  ));
  assert.deepEqual(projection.slowClient, {
    client: 4,
    pause: receipt(pause),
    resume: receipt(resume),
  });

  const discontinuities = evidence.transportEvents
    .filter(({ type }) => type === 'audio.discontinuity')
    .map((event) => ({
      client: event.client,
      connectionGeneration: event.payload.generation,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      transportSequence: event.sequence,
      transportEventSha256: transportEventSha256(event),
      scope: event.payload.scope,
      audioEpoch: event.payload.audioEpoch,
      streamRevision: event.payload.streamRevision,
      blockSeq: event.payload.blockSeq,
      resumeStartFrame: event.payload.resumeStartFrame,
    }));
  assert.deepEqual(projection.discontinuities, discontinuities);
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.runtimeOpens));
  assert.ok(Object.isFrozen(projection.slowClient.pause));
});

test('trusted composite returns validation and projection from one owned snapshot', () => {
  const { evidence, runBinding } = signedFixture();
  const alternateEvents = structuredClone(evidence.transportEvents);
  alternateEvents.find(({ type }) => type === 'runtime.open')
    .payload.clientIdentitySha256 = 'f'.repeat(64);
  let signerReads = 0;
  const switchingEvidence = new Proxy(evidence, {
    get(target, property, receiver) {
      if (property === 'signer') {
        signerReads += 1;
        if (signerReads === 1) {
          target.transportEvents = alternateEvents;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(
    () => validatePhase5FaultEvidenceWithClientProjection(
      switchingEvidence,
      runBinding,
    ),
    /PHASE5_FAULT_TRANSPORT_CHAIN_INVALID/,
  );

  const fresh = signedFixture();
  const composite = validatePhase5FaultEvidenceWithClientProjection(
    fresh.evidence,
    fresh.runBinding,
  );
  assert.deepEqual(Object.keys(composite), [
    'schemaVersion',
    'kind',
    'faultValidation',
    'signedTransportProjection',
  ]);
  assert.equal(composite.schemaVersion, 1);
  assert.equal(
    composite.kind,
    'phase5-fault-validation-with-client-projection-result',
  );
  assert.equal(composite.faultValidation.passed, true);
  assert.deepEqual(
    composite.signedTransportProjection,
    {
      ...projectPhase5ClientObservationsTransport(fresh.evidence),
      kind: 'phase5-client-observations-signed-transport-projection',
    },
  );
  assert.ok(Object.isFrozen(composite));
  assert.ok(Object.isFrozen(composite.faultValidation));
  assert.ok(Object.isFrozen(composite.signedTransportProjection));
});

test('trusted composite rejects transport tampering before projecting it', () => {
  const { evidence, runBinding } = signedFixture();
  evidence.transportEvents.find(({ type }) => type === 'runtime.open')
    .payload.clientIdentitySha256 = 'f'.repeat(64);

  assert.throws(
    () => validatePhase5FaultEvidenceWithClientProjection(
      evidence,
      runBinding,
    ),
    /PHASE5_FAULT_TRANSPORT_CHAIN_INVALID/,
  );
});
