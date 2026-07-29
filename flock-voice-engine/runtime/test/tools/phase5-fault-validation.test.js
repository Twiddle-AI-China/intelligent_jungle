import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicalJson,
} from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  validatePhase5FaultEvidence,
} from '../../tools/lib/phase5-fault-validation.mjs';
import {
  CHALLENGE,
  FAULT_SESSION_EVIDENCE_SHA256,
  GEOMETRY,
  PROFILE,
  RELEASE,
  RUN_ID,
  SCENARIOS,
  WINDOW,
  insertTransientPauseResume,
  signedFixture,
} from './phase5-fault-validation-fixture.js';

test('requires an independent exact trusted run binding', () => {
  assert.throws(
    () => validatePhase5FaultEvidence({}, undefined),
    /PHASE5_FAULT_RUN_BINDING_INVALID/,
  );
});

test('validates one signed object through structure, projection, semantics and a raw effect ledger', () => {
  const { evidence, runBinding } = signedFixture();
  const result = validatePhase5FaultEvidence(evidence, runBinding);
  const repeated = validatePhase5FaultEvidence(evidence, runBinding);

  assert.deepEqual(result, repeated);
  assert.deepEqual(Object.keys(result), [
    'schemaVersion',
    'kind',
    'passed',
    'runId',
    'challenge',
    'release',
    'geometry',
    'profile',
    'window',
    'signerSpkiSha256',
    'faultSessionEvidenceSha256',
    'evidence',
    'ledger',
  ]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, 'phase5-fault-validation-result');
  assert.equal(result.passed, true);
  assert.equal(result.runId, RUN_ID);
  assert.deepEqual(result.window, WINDOW);
  assert.equal(
    result.window.endedAtMonotonicMs
      - result.window.startedAtMonotonicMs,
    1_800_000,
  );
  assert.equal(
    result.faultSessionEvidenceSha256,
    FAULT_SESSION_EVIDENCE_SHA256,
  );
  assert.deepEqual(result.evidence, {
    schemaVersion: 2,
    faultEventsSha256: createHash('sha256')
      .update(Buffer.from(canonicalJson(evidence), 'utf8'))
      .digest('hex'),
    scenarioEventCount: evidence.scenarioEvents.length,
    transportEventCount: evidence.transportEvents.length,
    projectedStateCount: 21,
    unexpectedStabilityFailureCount: 0,
    eventChainSha256: evidence.eventChainSha256,
    transportChainSha256: evidence.transportChainSha256,
  });
  assert.deepEqual(
    result.ledger.map(({ scenario, passed }) => [scenario, passed]),
    SCENARIOS.map((scenario) => [scenario, true]),
  );
  assert.deepEqual(
    result.ledger.map(({ effects }) => effects.map(({ type, client }) => (
      `${type}:${client}`
    ))),
    [
      [
        'worker.sample:0',
        'worker.sample:0',
        'audio.discontinuity:1',
        'audio.discontinuity:2',
        'audio.discontinuity:3',
        'audio.discontinuity:4',
      ],
      [
        'runtime.egress:4',
        'runtime.close:4',
        'runtime.egress:4',
        'runtime.open:4',
        'runtime.ready:4',
      ],
      ['audio.pause:4', 'audio.resume:4'],
      [
        'runtime.egress:4',
        'runtime.close:4',
        'runtime.egress:4',
        'runtime.open:4',
        'runtime.ready:4',
      ],
      [
        'agent.start:0',
        'agent.settle:0',
        'agent.start:0',
        'agent.settle:0',
      ],
      [
        'agent.start:0',
        'agent.settle:0',
        'agent.start:0',
        'agent.settle:0',
      ],
      [
        'worker.sample:0',
        'audio.discontinuity:1',
        'audio.discontinuity:2',
        'audio.discontinuity:3',
        'audio.discontinuity:4',
      ],
    ],
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.release));
  assert.ok(Object.isFrozen(result.geometry.rowVoices));
  assert.ok(Object.isFrozen(result.window));
  assert.ok(Object.isFrozen(result.ledger));
  assert.ok(result.ledger.every((entry) => (
    Object.isFrozen(entry) && Object.isFrozen(entry.effects)
  )));
});

test('rejects a signed transient undeclared effect even when projected states are unchanged', () => {
  const { evidence, runBinding } = signedFixture({
    mutateRaw(raw) {
      const insertionIndex =
        raw.scenarioEvents[1].transportPrefixCount;
      insertTransientPauseResume(raw, insertionIndex, 1_150, 1_151);
    },
  });

  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_EFFECT_LEDGER_INVALID/,
  );
});

test('rejects undeclared effects hidden between before and fault action prefixes', () => {
  const { evidence, runBinding } = signedFixture({
    mutateRaw(raw) {
      const insertionIndex =
        raw.scenarioEvents[0].transportPrefixCount;
      insertTransientPauseResume(raw, insertionIndex, 1_050, 1_051);
      raw.scenarioEvents[1].transportPrefixCount += 2;
    },
  });

  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_EFFECT_LEDGER_INVALID/,
  );
});

test('rejects undeclared transient effects hidden in the initial prelude', () => {
  const { evidence, runBinding } = signedFixture({
    mutateRaw(raw) {
      const insertionIndex =
        raw.scenarioEvents[0].transportPrefixCount;
      insertTransientPauseResume(raw, insertionIndex, 500, 501);
      raw.scenarioEvents[0].transportPrefixCount += 2;
      raw.scenarioEvents[1].transportPrefixCount += 2;
    },
  });

  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_EFFECT_LEDGER_INVALID/,
  );
});

test('rejects undeclared effects hidden between fault observation and recovery action prefixes', () => {
  const { evidence, runBinding } = signedFixture({
    mutateRaw(raw) {
      const insertionIndex =
        raw.scenarioEvents[2].transportPrefixCount;
      insertTransientPauseResume(raw, insertionIndex, 1_550, 1_551);
      raw.scenarioEvents[3].transportPrefixCount += 2;
    },
  });

  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_EFFECT_LEDGER_INVALID/,
  );
});

test('rejects exotic or inexact trusted run binding objects at every level', () => {
  const { evidence, runBinding } = signedFixture();
  const attacks = [
    (value) => { value.extra = true; },
    (value) => { value[Symbol('hidden')] = true; },
    (value) => {
      Object.defineProperty(value, 'hidden', {
        value: true,
        enumerable: false,
      });
    },
    (value) => {
      Object.defineProperty(value, 'runId', {
        get: () => RUN_ID,
        enumerable: true,
      });
    },
    (value) => { Object.setPrototypeOf(value, { polluted: true }); },
    (value) => { value.release.extra = true; },
    (value) => {
      Object.defineProperty(value.release, 'releaseRevision', {
        get: () => RELEASE.releaseRevision,
        enumerable: true,
      });
    },
    (value) => { value.geometry.rowVoices[Symbol('hidden')] = true; },
    (value) => { Object.setPrototypeOf(value.profile, { polluted: true }); },
    (value) => { value.faultSessionEvidenceSha256 = 'not-a-sha'; },
  ];

  for (const attack of attacks) {
    const candidate = structuredClone(runBinding);
    attack(candidate);
    assert.throws(
      () => validatePhase5FaultEvidence(evidence, candidate),
      /PHASE5_FAULT_RUN_BINDING_INVALID/,
    );
  }
});

test('rejects accessor, symbol, non-enumerable and custom-prototype evidence shapes', () => {
  const { evidence, runBinding } = signedFixture();
  const attacks = [
    (value) => {
      Object.defineProperty(value, 'runId', {
        get: () => RUN_ID,
        enumerable: true,
      });
    },
    (value) => { value[Symbol('hidden')] = true; },
    (value) => {
      Object.defineProperty(value, 'hidden', {
        value: true,
        enumerable: false,
      });
    },
    (value) => { Object.setPrototypeOf(value, { polluted: true }); },
    (value) => {
      value.signer = { ...value.signer };
      Object.defineProperty(value.signer, 'publicKeySpkiSha256', {
        get: () => runBinding.signerSpkiSha256,
        enumerable: true,
      });
    },
  ];

  for (const attack of attacks) {
    const candidate = { ...evidence };
    attack(candidate);
    assert.throws(
      () => validatePhase5FaultEvidence(candidate, runBinding),
      /PHASE5_FAULT_(?:EVIDENCE_SHAPE|SIGNER)_INVALID/,
    );
  }
});

test('uses one validator-owned snapshot across signature and interpretation', () => {
  const { evidence, runBinding } = signedFixture();
  const alteredTransport = structuredClone(evidence.transportEvents);
  alteredTransport[0].previousTransportSha256 = 'f'.repeat(64);
  let signerReads = 0;
  const switchingEvidence = new Proxy(evidence, {
    get(target, property, receiver) {
      if (property === 'signer') {
        signerReads += 1;
        if (signerReads === 1) {
          target.transportEvents = alteredTransport;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(
    () => validatePhase5FaultEvidence(switchingEvidence, runBinding),
    /PHASE5_FAULT_TRANSPORT_CHAIN_INVALID/,
  );
});

test('cross-binds run, challenge, release, fixed geometry/profile and external signer', () => {
  const { evidence, runBinding } = signedFixture();
  const attacks = [
    [
      (value) => {
        value.runId = '123e4567-e89b-42d3-a456-426614174001';
      },
      /PHASE5_FAULT_RUN_BINDING_MISMATCH/,
    ],
    [
      (value) => { value.challenge = '3'.repeat(64); },
      /PHASE5_FAULT_RUN_BINDING_MISMATCH/,
    ],
    [
      (value) => {
        value.release.releaseManifestSha256 = 'e'.repeat(64);
      },
      /PHASE5_FAULT_RUN_BINDING_MISMATCH/,
    ],
    [
      (value) => { value.geometry.sampleRate = 48_000; },
      /PHASE5_FAULT_RUN_BINDING_INVALID/,
    ],
    [
      (value) => { value.profile.clients = 5; },
      /PHASE5_FAULT_RUN_BINDING_INVALID/,
    ],
    [
      (value) => { value.signerSpkiSha256 = 'f'.repeat(64); },
      /PHASE5_FAULT_SIGNER_BINDING_INVALID/,
    ],
  ];

  for (const [attack, expected] of attacks) {
    const candidate = structuredClone(runBinding);
    attack(candidate);
    assert.throws(
      () => validatePhase5FaultEvidence(evidence, candidate),
      expected,
    );
  }
  assert.throws(
    () => validatePhase5FaultEvidence(evidence, evidence),
    /PHASE5_FAULT_RUN_BINDING_INVALID/,
  );
});

test('treats the independently verified session evidence SHA only as trusted input', () => {
  const { evidence, runBinding } = signedFixture();
  const independentlyVerified = {
    ...runBinding,
    faultSessionEvidenceSha256: 'f'.repeat(64),
  };
  const result = validatePhase5FaultEvidence(
    evidence,
    independentlyVerified,
  );
  assert.equal(
    result.faultSessionEvidenceSha256,
    independentlyVerified.faultSessionEvidenceSha256,
  );
});

test('rejects generic claims and producer-authored pass/count/projection fields', () => {
  const generic = signedFixture({ typed: false });
  assert.throws(
    () => validatePhase5FaultEvidence(
      generic.evidence,
      generic.runBinding,
    ),
    /PHASE5_FAULT_PAYLOAD_INVALID/,
  );

  const { evidence, runBinding } = signedFixture();
  for (const [field, value] of [
    ['passed', true],
    ['counts', { scenarios: 7 }],
    ['transportProjection', { producer: 'trusted-me' }],
  ]) {
    const candidate = { ...evidence, [field]: value };
    assert.throws(
      () => validatePhase5FaultEvidence(candidate, runBinding),
      /PHASE5_FAULT_EVIDENCE_SHAPE_INVALID/,
    );
  }
});

test('rejects signed typed state that differs from the raw projection', () => {
  const { evidence, runBinding } = signedFixture({
    mutateScenarioDrafts(drafts) {
      for (const draft of drafts) {
        if (draft.payload.kind === 'state') {
          draft.payload.state.world.revision += 100;
          draft.payload.state.world.eventSeq += 100;
        }
      }
    },
  });
  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_TRANSPORT_PROJECTION_MISMATCH/,
  );
});

test('rejects a signed timeline whose observations stop before the signed window end', () => {
  const { evidence, runBinding } = signedFixture({
    mutateTransportDrafts(drafts) {
      for (let index = drafts.length - 1; index >= 0; index -= 1) {
        if (drafts[index].atMonotonicMs >= 1_790_000
            && drafts[index].atMonotonicMs < 1_800_000
            && ['runtime.snapshot', 'worker.sample'].includes(
              drafts[index].type,
            )) {
          drafts.splice(index, 1);
        }
      }
      const lastSnapshots = [1, 2, 3, 4].map((clientId) => (
        drafts.findLast((draft) => (
          draft.type === 'runtime.snapshot'
            && draft.client === clientId
            && draft.atMonotonicMs < 1_800_000
        ))
      ));
      const finalRevision = lastSnapshots[0].payload.revision + 1;
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        const finalSnapshot = drafts.find((draft) => (
          draft.type === 'runtime.snapshot'
            && draft.client === clientId
            && draft.atMonotonicMs === 1_800_000
        ));
        finalSnapshot.payload.probeSeq =
          lastSnapshots[clientId - 1].payload.probeSeq + 1;
        finalSnapshot.payload.revision = finalRevision;
        finalSnapshot.payload.eventSeq = finalRevision;
      }
    },
  });
  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_STABILITY_TAIL_(?:INCOMPLETE|OBSERVATION_GAP|PCM_GAP)/,
  );
});

test('validates the signed chain before interpreting producer payloads', () => {
  const { evidence, runBinding } = signedFixture({ typed: false });
  evidence.scenarioEvents[0].signature =
    Buffer.alloc(64, 1).toString('base64');
  assert.throws(
    () => validatePhase5FaultEvidence(evidence, runBinding),
    /PHASE5_FAULT_(?:EVENT_CHAIN|EVENT_SIGNATURE|CLOSURE)_INVALID/,
  );
});
