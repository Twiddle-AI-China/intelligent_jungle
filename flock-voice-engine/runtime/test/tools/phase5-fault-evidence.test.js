import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  FAULT_EVENT_PHASES,
  FAULT_TRANSPORT_EVENT_TYPES,
  REAL_FAULT_SCENARIOS,
  ZERO_EVENT_SHA256,
  canonicalJson,
  createEd25519SignerDescriptor,
  createSignedFaultEventEvidence,
  faultEventSha256,
  faultEventSigningBytes,
  faultRunClosureSigningBytes,
  transportEventSha256,
  validateSignedFaultEventEvidence,
} from '../../tools/lib/phase5-fault-evidence.mjs';

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const CHALLENGE = '1'.repeat(64);
const RELEASE = Object.freeze({
  releaseManifestSha256: 'a'.repeat(64),
  releaseRevision: 'b'.repeat(40),
  sourceManifestSha256: 'c'.repeat(64),
  audioArtifactSha256: 'd'.repeat(64),
});
const GEOMETRY = Object.freeze({
  sampleRate: 44_100,
  blockFrames: 4_096,
  poolSize: 5,
  rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'],
});
const PROFILE = Object.freeze({
  clients: 4,
  slowClient: 4,
  durationMinutes: 30,
  speciesEndpoint: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent',
});
const WINDOW = Object.freeze({
  startedAtMonotonicMs: 100_000,
  endedAtMonotonicMs: 1_900_000,
  startedAtUnixMs: 1_800_000_000_000,
  endedAtUnixMs: 1_800_001_800_000,
});

function eventDrafts({ transportPrefixCount = 1 } = {}) {
  return REAL_FAULT_SCENARIOS.flatMap(({ scenario }, scenarioIndex) => {
    const base = WINDOW.startedAtMonotonicMs + 1_000 + scenarioIndex * 100_000;
    const phaseOffsets = scenario === 'slow-client'
      ? [0, 100, 2_100, 2_200, 3_000]
      : [0, 100, 200, 300, 1_000];
    return FAULT_EVENT_PHASES.map((phase, phaseIndex) => {
      const atMonotonicMs = base + phaseOffsets[phaseIndex];
      return {
        scenario,
        phase,
        atMonotonicMs,
        atUnixMs: WINDOW.startedAtUnixMs
          + (atMonotonicMs - WINDOW.startedAtMonotonicMs),
        transportPrefixCount: scenarioIndex === 0 && phaseIndex === 0
          ? 0
          : transportPrefixCount,
        payload: { marker: `${scenario}:${phase}` },
      };
    });
  });
}

function transportDrafts() {
  return [{
    atMonotonicMs: WINDOW.startedAtMonotonicMs + 1_050,
    atUnixMs: WINDOW.startedAtUnixMs + 1_050,
    client: 1,
    type: 'runtime.open',
    payload: { generation: 1 },
  }];
}

function tailTransportDraft() {
  return {
    atMonotonicMs: WINDOW.endedAtMonotonicMs - 100,
    atUnixMs: WINDOW.endedAtUnixMs - 100,
    client: 1,
    type: 'runtime.snapshot',
    payload: { marker: 'window-end-observation' },
  };
}

function withWindowTail(transports) {
  if (transports.length === 0) return transports;
  const last = transports.at(-1);
  if (WINDOW.endedAtMonotonicMs - last.atMonotonicMs <= 250
      && WINDOW.endedAtUnixMs - last.atUnixMs <= 250) {
    return transports;
  }
  return [...transports, tailTransportDraft()];
}

function allTransportTypeDrafts() {
  const globalTypes = new Set([
    'worker.sample',
    'agent.start',
    'agent.settle',
    'observer.failure',
  ]);
  return FAULT_TRANSPORT_EVENT_TYPES.map((type, index) => ({
    atMonotonicMs: WINDOW.startedAtMonotonicMs + 1_010 + index,
    atUnixMs: WINDOW.startedAtUnixMs + 1_010 + index,
    client: globalTypes.has(type) ? 0 : 1,
    type,
    payload: { marker: type },
  }));
}

function fixture(keyPair = generateKeyPairSync('ed25519')) {
  return buildFixtureFromDrafts(eventDrafts(), keyPair, transportDrafts());
}

function buildFixtureFromDrafts(
  drafts,
  keyPair = generateKeyPairSync('ed25519'),
  transports = transportDrafts(),
) {
  const evidence = createSignedFaultEventEvidence({
    runId: RUN_ID,
    challenge: CHALLENGE,
    release: RELEASE,
    geometry: GEOMETRY,
    profile: PROFILE,
    window: WINDOW,
    scenarioEvents: drafts,
    transportEvents: withWindowTail(transports),
  }, keyPair);
  return { evidence, ...keyPair };
}

function rebindOrdinaryShaChain(evidence) {
  let previous = ZERO_EVENT_SHA256;
  for (const event of evidence.scenarioEvents) {
    event.previousEventSha256 = previous;
    previous = faultEventSha256(event);
  }
  evidence.eventChainSha256 = previous;
}

function rebindOrdinaryTransportShaChain(evidence) {
  let previous = ZERO_EVENT_SHA256;
  for (const [index, event] of evidence.transportEvents.entries()) {
    event.sequence = index + 1;
    event.previousTransportSha256 = previous;
    previous = transportEventSha256(event);
  }
  evidence.transportChainSha256 = previous;
}

function setEventTime(event, atMonotonicMs) {
  event.atMonotonicMs = atMonotonicMs;
  event.atUnixMs = WINDOW.startedAtUnixMs
    + (atMonotonicMs - WINDOW.startedAtMonotonicMs);
}

test('real fault plan freezes seven scenarios and five phases in exact order', () => {
  assert.deepEqual(
    REAL_FAULT_SCENARIOS.map(({ scenario, recoverySloMs }) => [scenario, recoverySloMs]),
    [
      ['worker-crash-restart', 15_000],
      ['runtime-reconnect', 5_000],
      ['slow-client', 7_000],
      ['queue-pressure', 5_000],
      ['agent-timeout', 15_000],
      ['agent-malformed-response', 15_000],
      ['audio-epoch-discontinuity', 10_000],
    ],
  );
  assert.deepEqual(FAULT_EVENT_PHASES, [
    'before',
    'fault-action',
    'fault-observed',
    'recovery-action',
    'recovery-observed',
  ]);
});

test('canonical signing bytes bind challenge, release and unsigned event', () => {
  const event = {
    sequence: 1,
    runId: RUN_ID,
    scenario: 'worker-crash-restart',
    phase: 'before',
    atMonotonicMs: 101_000,
    atUnixMs: 1_800_000_001_000,
    previousEventSha256: ZERO_EVENT_SHA256,
    transportPrefixCount: 0,
    transportPrefixSha256: ZERO_EVENT_SHA256,
    payload: { z: 2, a: 1 },
    signature: Buffer.alloc(64).toString('base64'),
  };
  const expectedBody = canonicalJson({
    challenge: CHALLENGE,
    release: RELEASE,
    event: {
      sequence: event.sequence,
      runId: event.runId,
      scenario: event.scenario,
      phase: event.phase,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      previousEventSha256: event.previousEventSha256,
      transportPrefixCount: event.transportPrefixCount,
      transportPrefixSha256: event.transportPrefixSha256,
      payload: event.payload,
    },
  });
  assert.deepEqual(
    faultEventSigningBytes({ challenge: CHALLENGE, release: RELEASE, event }),
    Buffer.concat([
      Buffer.from('flock-phase5-fault-event-v1\0', 'utf8'),
      Buffer.from(expectedBody, 'utf8'),
    ]),
  );
});

test('builder creates an externally key-bound, exact 35-event signed chain', () => {
  const { evidence, publicKey } = fixture();

  assert.deepEqual(Object.keys(evidence).sort(), [
    'challenge',
    'closure',
    'eventChainSha256',
    'geometry',
    'kind',
    'profile',
    'release',
    'runId',
    'scenarioEvents',
    'schemaVersion',
    'signer',
    'transportChainSha256',
    'transportEvents',
    'window',
  ]);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.scenarioEvents.length, 35);
  assert.deepEqual(
    evidence.scenarioEvents.map(({ sequence }) => sequence),
    Array.from({ length: 35 }, (_, index) => index + 1),
  );
  assert.equal(evidence.scenarioEvents[0].previousEventSha256, ZERO_EVENT_SHA256);
  assert.equal(
    evidence.eventChainSha256,
    faultEventSha256(evidence.scenarioEvents.at(-1)),
  );
  assert.equal(evidence.transportEvents.length, 2);
  assert.equal(
    evidence.transportChainSha256,
    transportEventSha256(evidence.transportEvents.at(-1)),
  );
  assert.deepEqual(Object.keys(evidence.scenarioEvents[0]).sort(), [
    'atMonotonicMs',
    'atUnixMs',
    'payload',
    'phase',
    'previousEventSha256',
    'runId',
    'scenario',
    'sequence',
    'signature',
    'transportPrefixCount',
    'transportPrefixSha256',
  ]);
  assert.equal(evidence.scenarioEvents[0].transportPrefixCount, 0);
  assert.equal(
    evidence.scenarioEvents[0].transportPrefixSha256,
    ZERO_EVENT_SHA256,
  );
  assert.equal(evidence.scenarioEvents.at(-1).transportPrefixCount, 1);
  assert.equal(
    evidence.scenarioEvents.at(-1).transportPrefixSha256,
    transportEventSha256(evidence.transportEvents[0]),
  );
  assert.deepEqual(Object.keys(evidence.closure).sort(), [
    'scenarioEventCount',
    'signature',
    'transportEventCount',
  ]);
  assert.equal(evidence.closure.scenarioEventCount, 35);
  assert.equal(evidence.closure.transportEventCount, 2);
  assert.deepEqual(evidence.signer, createEd25519SignerDescriptor(publicKey));
  assert.equal(
    validateSignedFaultEventEvidence(evidence, { expectedPublicKey: publicKey }),
    evidence,
  );
  assert.equal(
    validateSignedFaultEventEvidence(evidence, {
      expectedSignerSpkiSha256: evidence.signer.publicKeySpkiSha256,
    }),
    evidence,
  );
});

test('schema v2 rejects a downgraded v1 document', () => {
  const { evidence, publicKey } = fixture();
  evidence.schemaVersion = 1;
  assert.throws(
    () => validateSignedFaultEventEvidence(evidence, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_EVIDENCE_SHAPE_INVALID/,
  );
});

test('transport type enum and client ownership rules are frozen', () => {
  assert.deepEqual(FAULT_TRANSPORT_EVENT_TYPES, [
    'runtime.open',
    'runtime.ready',
    'runtime.snapshot',
    'runtime.close',
    'runtime.egress',
    'audio.open',
    'audio.ready',
    'audio.pcm',
    'audio.discontinuity',
    'audio.pause',
    'audio.resume',
    'audio.close',
    'worker.sample',
    'agent.start',
    'agent.settle',
    'observer.failure',
  ]);

  const transports = allTransportTypeDrafts();
  const { evidence, publicKey } = buildFixtureFromDrafts(
    eventDrafts({ transportPrefixCount: transports.length }),
    generateKeyPairSync('ed25519'),
    transports,
  );
  assert.equal(
    validateSignedFaultEventEvidence(evidence, { expectedPublicKey: publicKey }),
    evidence,
  );
});

test('builder creates exact run-bound transport envelopes and an ordinary SHA chain', () => {
  const { evidence } = fixture();
  const event = evidence.transportEvents[0];
  assert.deepEqual(Object.keys(event).sort(), [
    'atMonotonicMs',
    'atUnixMs',
    'client',
    'payload',
    'previousTransportSha256',
    'runId',
    'sequence',
    'type',
  ]);
  assert.deepEqual(event, {
    sequence: 1,
    runId: RUN_ID,
    atMonotonicMs: WINDOW.startedAtMonotonicMs + 1_050,
    atUnixMs: WINDOW.startedAtUnixMs + 1_050,
    client: 1,
    type: 'runtime.open',
    previousTransportSha256: ZERO_EVENT_SHA256,
    payload: { generation: 1 },
  });
  assert.equal(
    evidence.transportChainSha256,
    transportEventSha256(evidence.transportEvents.at(-1)),
  );
});

test('closure signing bytes bind the full run contract and both chain counts', () => {
  const { evidence } = fixture();
  const expectedBody = canonicalJson({
    runId: evidence.runId,
    challenge: evidence.challenge,
    release: evidence.release,
    geometry: evidence.geometry,
    profile: evidence.profile,
    window: evidence.window,
    eventChainSha256: evidence.eventChainSha256,
    transportChainSha256: evidence.transportChainSha256,
    scenarioEventCount: evidence.closure.scenarioEventCount,
    transportEventCount: evidence.closure.transportEventCount,
  });
  assert.deepEqual(
    faultRunClosureSigningBytes(evidence),
    Buffer.concat([
      Buffer.from('flock-phase5-run-closure-v1\0', 'utf8'),
      Buffer.from(expectedBody, 'utf8'),
    ]),
  );
});

test('closure signing refuses a non-exact evidence shell', () => {
  const { evidence } = fixture();
  evidence.notSigned = true;
  assert.throws(
    () => faultRunClosureSigningBytes(evidence),
    /PHASE5_FAULT_CLOSURE_INVALID/,
  );
});

test('transport chain requires at least one event and continuous exact envelopes', () => {
  assert.throws(
    () => buildFixtureFromDrafts(
      eventDrafts({ transportPrefixCount: 0 }),
      generateKeyPairSync('ed25519'),
      [],
    ),
    /PHASE5_FAULT_TRANSPORT_COUNT_INVALID/,
  );

  const mutations = [
    ['sequence', (evidence) => { evidence.transportEvents[0].sequence = 2; }],
    ['run', (evidence) => {
      evidence.transportEvents[0].runId =
        '123e4567-e89b-42d3-a456-426614174001';
    }],
    ['previous digest', (evidence) => {
      evidence.transportEvents[0].previousTransportSha256 = 'e'.repeat(64);
    }],
    ['extra key', (evidence) => { evidence.transportEvents[0].extra = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const { evidence, publicKey } = fixture();
    mutate(evidence);
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_TRANSPORT_(?:SHAPE|RUN_BINDING|CHAIN)_INVALID/,
      name,
    );
  }
});

test('transport clocks are safe, window-bound, ordered and share one offset', () => {
  const mutations = [
    ['fraction', (event) => { event.atMonotonicMs = 1.5; }],
    ['boolean', (event) => { event.atUnixMs = true; }],
    ['before window', (event) => {
      event.atMonotonicMs = WINDOW.startedAtMonotonicMs - 1;
      event.atUnixMs = WINDOW.startedAtUnixMs - 1;
    }],
    ['clock skew', (event) => { event.atUnixMs += 2; }],
  ];
  for (const [name, mutate] of mutations) {
    const { evidence, publicKey } = fixture();
    mutate(evidence.transportEvents[0]);
    rebindOrdinaryTransportShaChain(evidence);
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_TRANSPORT_TIME_INVALID/,
      name,
    );
  }

  const reversed = allTransportTypeDrafts().slice(0, 2);
  reversed[1].atMonotonicMs = reversed[0].atMonotonicMs - 1;
  reversed[1].atUnixMs = reversed[0].atUnixMs - 1;
  assert.throws(
    () => buildFixtureFromDrafts(
      eventDrafts({ transportPrefixCount: 2 }),
      generateKeyPairSync('ed25519'),
      reversed,
    ),
    /PHASE5_FAULT_TRANSPORT_TIME_INVALID/,
  );
});

test('signed transport evidence must reach the measurement window end', () => {
  assert.throws(
    () => createSignedFaultEventEvidence({
      runId: RUN_ID,
      challenge: CHALLENGE,
      release: RELEASE,
      geometry: GEOMETRY,
      profile: PROFILE,
      window: WINDOW,
      scenarioEvents: eventDrafts(),
      transportEvents: transportDrafts(),
    }, generateKeyPairSync('ed25519')),
    /PHASE5_FAULT_TRANSPORT_WINDOW_INCOMPLETE/,
  );
});

test('runtime and audio transport events belong to clients 1..4 only', () => {
  const clientTypes = FAULT_TRANSPORT_EVENT_TYPES.filter(
    (type) => type.startsWith('runtime.') || type.startsWith('audio.'),
  );
  for (const type of clientTypes) {
    for (const client of [0, 5, true, 1.5]) {
      const transports = transportDrafts();
      transports[0].type = type;
      transports[0].client = client;
      assert.throws(
        () => buildFixtureFromDrafts(
          eventDrafts(),
          generateKeyPairSync('ed25519'),
          transports,
        ),
        /PHASE5_FAULT_TRANSPORT_CLIENT_INVALID/,
        `${type}:${client}`,
      );
    }
  }
});

test('worker agent and observer transport events belong to global client zero only', () => {
  for (const type of [
    'worker.sample',
    'agent.start',
    'agent.settle',
    'observer.failure',
  ]) {
    for (const client of [1, 4, true, 0.5]) {
      const transports = transportDrafts();
      transports[0].type = type;
      transports[0].client = client;
      assert.throws(
        () => buildFixtureFromDrafts(
          eventDrafts(),
          generateKeyPairSync('ed25519'),
          transports,
        ),
        /PHASE5_FAULT_TRANSPORT_CLIENT_INVALID/,
        `${type}:${client}`,
      );
    }
  }
});

test('transport type and payload are exact ordinary canonical data', () => {
  {
    const transports = transportDrafts();
    transports[0].type = 'runtime.connected';
    assert.throws(
      () => buildFixtureFromDrafts(eventDrafts(), generateKeyPairSync('ed25519'), transports),
      /PHASE5_FAULT_TRANSPORT_TYPE_INVALID/,
    );
  }
  for (const payload of [[], new Date(0), Object.create(null)]) {
    const transports = transportDrafts();
    transports[0].payload = payload;
    assert.throws(
      () => buildFixtureFromDrafts(eventDrafts(), generateKeyPairSync('ed25519'), transports),
      /PHASE5_FAULT_TRANSPORT_(?:DRAFT|PAYLOAD)_INVALID/,
    );
  }
});

test('scenario transport prefixes are monotonic and bind exact included digests', () => {
  const { evidence, publicKey } = fixture();
  const zeroHash = structuredClone(evidence);
  zeroHash.scenarioEvents[0].transportPrefixSha256 = 'f'.repeat(64);
  rebindOrdinaryShaChain(zeroHash);
  assert.throws(
    () => validateSignedFaultEventEvidence(zeroHash, { expectedPublicKey: publicKey }),
    /PHASE5_FAULT_TRANSPORT_PREFIX_INVALID/,
  );

  const wrongHash = structuredClone(evidence);
  wrongHash.scenarioEvents[1].transportPrefixSha256 = 'f'.repeat(64);
  rebindOrdinaryShaChain(wrongHash);
  assert.throws(
    () => validateSignedFaultEventEvidence(wrongHash, { expectedPublicKey: publicKey }),
    /PHASE5_FAULT_TRANSPORT_PREFIX_INVALID/,
  );

  const regressedDrafts = eventDrafts();
  regressedDrafts[2].transportPrefixCount = 0;
  assert.throws(
    () => buildFixtureFromDrafts(regressedDrafts),
    /PHASE5_FAULT_TRANSPORT_PREFIX_INVALID/,
  );
});

test('a scenario prefix cannot include transport from its future', () => {
  const drafts = eventDrafts();
  drafts[0].transportPrefixCount = 1;
  assert.throws(
    () => buildFixtureFromDrafts(drafts),
    /PHASE5_FAULT_TRANSPORT_PREFIX_TIME_INVALID/,
  );
});

test('every scenario prefix is the fully flushed prefix at its signed time', () => {
  const omittedPastTransport = {
    atMonotonicMs: WINDOW.startedAtMonotonicMs + 999,
    atUnixMs: WINDOW.startedAtUnixMs + 999,
    client: 1,
    type: 'runtime.open',
    payload: { generation: 1 },
  };
  assert.throws(
    () => buildFixtureFromDrafts(
      eventDrafts(),
      generateKeyPairSync('ed25519'),
      [omittedPastTransport],
    ),
    /PHASE5_FAULT_TRANSPORT_PREFIX_INCOMPLETE/,
  );
});

test('the last scenario prefix must be nonzero but may exclude stability-tail transport', () => {
  const tailTransport = {
    atMonotonicMs: WINDOW.endedAtMonotonicMs - 100,
    atUnixMs: WINDOW.endedAtUnixMs - 100,
    client: 1,
    type: 'audio.pcm',
    payload: { marker: 'tail' },
  };
  const { evidence, publicKey } = buildFixtureFromDrafts(
    eventDrafts(),
    generateKeyPairSync('ed25519'),
    [...transportDrafts(), tailTransport],
  );
  assert.equal(evidence.scenarioEvents.at(-1).transportPrefixCount, 1);
  assert.equal(evidence.transportEvents.length, 2);
  assert.equal(
    validateSignedFaultEventEvidence(evidence, { expectedPublicKey: publicKey }),
    evidence,
  );

  const noObservedTransport = eventDrafts({ transportPrefixCount: 0 });
  assert.throws(
    () => buildFixtureFromDrafts(
      noObservedTransport,
      generateKeyPairSync('ed25519'),
      [tailTransport],
    ),
    /PHASE5_FAULT_TRANSPORT_PREFIX_INVALID/,
  );
});

test('scenario prefix fields are part of the Ed25519 event signature', () => {
  const transports = [
    ...transportDrafts(),
    {
      atMonotonicMs: WINDOW.startedAtMonotonicMs + 1_060,
      atUnixMs: WINDOW.startedAtUnixMs + 1_060,
      client: 1,
      type: 'runtime.ready',
      payload: {},
    },
  ];
  const { evidence, publicKey } = buildFixtureFromDrafts(
    eventDrafts({ transportPrefixCount: 2 }),
    generateKeyPairSync('ed25519'),
    transports,
  );
  const tampered = structuredClone(evidence);
  tampered.scenarioEvents[1].transportPrefixCount = 1;
  tampered.scenarioEvents[1].transportPrefixSha256 =
    tampered.transportEvents[0] === undefined
      ? ZERO_EVENT_SHA256
      : transportEventSha256(tampered.transportEvents[0]);
  rebindOrdinaryShaChain(tampered);
  assert.throws(
    () => validateSignedFaultEventEvidence(tampered, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_(?:EVENT_SIGNATURE_INVALID|TRANSPORT_PREFIX_INCOMPLETE)/,
  );
});

test('append truncate reorder and payload tampering cannot survive closure validation', () => {
  const transports = allTransportTypeDrafts().slice(0, 2);
  const { evidence, publicKey } = buildFixtureFromDrafts(
    eventDrafts({ transportPrefixCount: 2 }),
    generateKeyPairSync('ed25519'),
    transports,
  );
  const attacks = [
    ['append', (value) => {
      const last = value.transportEvents.at(-1);
      value.transportEvents.push({
        ...structuredClone(last),
        sequence: 3,
        atMonotonicMs: last.atMonotonicMs + 1,
        atUnixMs: last.atUnixMs + 1,
        previousTransportSha256: value.transportChainSha256,
      });
      rebindOrdinaryTransportShaChain(value);
    }],
    ['truncate', (value) => {
      value.transportEvents.pop();
      rebindOrdinaryTransportShaChain(value);
    }],
    ['reorder', (value) => {
      [value.transportEvents[0], value.transportEvents[1]] =
        [value.transportEvents[1], value.transportEvents[0]];
      rebindOrdinaryTransportShaChain(value);
    }],
    ['payload', (value) => {
      value.transportEvents[0].payload.marker = 'tampered';
      rebindOrdinaryTransportShaChain(value);
    }],
  ];
  for (const [name, mutate] of attacks) {
    const attacked = structuredClone(evidence);
    mutate(attacked);
    assert.throws(
      () => validateSignedFaultEventEvidence(attacked, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_(?:(?:TRANSPORT_PREFIX|CLOSURE|TRANSPORT_CHAIN|TRANSPORT_TIME)_INVALID|TRANSPORT_PREFIX_INCOMPLETE|TRANSPORT_WINDOW_INCOMPLETE)/,
      name,
    );
  }
});

test('closure exact shape, counts, chains, profile and window are fail closed', () => {
  const attacks = [
    ['extra', (evidence) => { evidence.closure.extra = true; }],
    ['scenario count', (evidence) => { evidence.closure.scenarioEventCount -= 1; }],
    ['transport count', (evidence) => { evidence.closure.transportEventCount += 1; }],
    ['event chain', (evidence) => { evidence.eventChainSha256 = 'e'.repeat(64); }],
    ['transport chain', (evidence) => {
      evidence.transportChainSha256 = 'e'.repeat(64);
    }],
    ['profile', (evidence) => { evidence.profile.clients = 3; }],
    ['window', (evidence) => {
      evidence.window.startedAtMonotonicMs -= 1;
      evidence.window.endedAtMonotonicMs -= 1;
    }],
    ['signature', (evidence) => {
      evidence.closure.signature = Buffer.alloc(64, 1).toString('base64');
    }],
  ];
  for (const [name, mutate] of attacks) {
    const { evidence, publicKey } = fixture();
    mutate(evidence);
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_(?:CLOSURE|EVENT_CHAIN|TRANSPORT_CHAIN|PROFILE|WINDOW)_INVALID/,
      name,
    );
  }
});

test('payload tampering remains rejected after rebinding every ordinary SHA link', () => {
  const { evidence, publicKey } = fixture();
  const tampered = structuredClone(evidence);
  tampered.scenarioEvents[12].payload.marker = 'forged-observation';
  rebindOrdinaryShaChain(tampered);

  assert.equal(
    tampered.eventChainSha256,
    faultEventSha256(tampered.scenarioEvents.at(-1)),
  );
  assert.throws(
    () => validateSignedFaultEventEvidence(tampered, { expectedPublicKey: publicKey }),
    /PHASE5_FAULT_EVENT_SIGNATURE_INVALID/,
  );
});

test('validator rejects a wrong scenario order before trusting signatures', () => {
  const { evidence, publicKey } = fixture();
  const wrongOrder = structuredClone(evidence);
  wrongOrder.scenarioEvents[5].scenario = 'slow-client';
  rebindOrdinaryShaChain(wrongOrder);
  assert.throws(
    () => validateSignedFaultEventEvidence(wrongOrder, { expectedPublicKey: publicKey }),
    /PHASE5_FAULT_EVENT_PLAN_INVALID/,
  );
});

test('validator rejects a missing event even if the remaining chain is rebound', () => {
  const { evidence, publicKey } = fixture();
  const missing = structuredClone(evidence);
  missing.scenarioEvents.splice(8, 1);
  missing.scenarioEvents.forEach((event, index) => { event.sequence = index + 1; });
  rebindOrdinaryShaChain(missing);
  assert.throws(
    () => validateSignedFaultEventEvidence(missing, { expectedPublicKey: publicKey }),
    /PHASE5_FAULT_EVENT_COUNT_INVALID/,
  );
});

test('validator rejects an event bound to the wrong runId', () => {
  const { evidence, publicKey } = fixture();
  const wrongRun = structuredClone(evidence);
  wrongRun.scenarioEvents[10].runId = '123e4567-e89b-42d3-a456-426614174001';
  rebindOrdinaryShaChain(wrongRun);
  assert.throws(
    () => validateSignedFaultEventEvidence(wrongRun, { expectedPublicKey: publicKey }),
    /PHASE5_FAULT_EVENT_RUN_BINDING_INVALID/,
  );
});

test('validator rejects release rebinding even when the ordinary SHA chain is valid', () => {
  const { evidence, publicKey } = fixture();
  const wrongRelease = structuredClone(evidence);
  wrongRelease.release.releaseManifestSha256 = 'e'.repeat(64);
  rebindOrdinaryShaChain(wrongRelease);
  assert.throws(
    () => validateSignedFaultEventEvidence(wrongRelease, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_EVENT_SIGNATURE_INVALID/,
  );
});

test('validator rejects monotonic and unix time regressions', () => {
  const { evidence, publicKey } = fixture();
  for (const field of ['atMonotonicMs', 'atUnixMs']) {
    const regressed = structuredClone(evidence);
    regressed.scenarioEvents[3][field] = regressed.scenarioEvents[2][field] - 1;
    rebindOrdinaryShaChain(regressed);
    assert.throws(
      () => validateSignedFaultEventEvidence(regressed, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_EVENT_TIME_INVALID/,
      field,
    );
  }
});

test('validator rejects scenario overlap at a shared boundary timestamp', () => {
  const { evidence, publicKey } = fixture();
  const overlap = structuredClone(evidence);
  setEventTime(
    overlap.scenarioEvents[5],
    overlap.scenarioEvents[4].atMonotonicMs,
  );
  rebindOrdinaryShaChain(overlap);
  assert.throws(
    () => validateSignedFaultEventEvidence(overlap, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_SCENARIO_OVERLAP/,
  );
});

test('validator rejects recovery outside the scenario SLO', () => {
  const { evidence, publicKey } = fixture();
  const late = structuredClone(evidence);
  setEventTime(
    late.scenarioEvents[4],
    late.scenarioEvents[1].atMonotonicMs + 15_001,
  );
  rebindOrdinaryShaChain(late);
  assert.throws(
    () => validateSignedFaultEventEvidence(late, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_RECOVERY_SLO_EXCEEDED/,
  );
});

test('validator rejects unsafe event timestamps', () => {
  const { evidence, publicKey } = fixture();
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const unsafe = structuredClone(evidence);
    unsafe.scenarioEvents[2].atMonotonicMs = value;
    rebindOrdinaryShaChain(unsafe);
    assert.throws(
      () => validateSignedFaultEventEvidence(unsafe, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_EVENT_TIME_INVALID/,
    );
  }
});

test('validator rejects a wrong external Ed25519 key', () => {
  const { evidence } = fixture();
  const wrong = generateKeyPairSync('ed25519');
  assert.throws(
    () => validateSignedFaultEventEvidence(evidence, {
      expectedPublicKey: wrong.publicKey,
    }),
    /PHASE5_FAULT_SIGNER_BINDING_INVALID/,
  );
});

test('canonical JSON rejects hidden state, sparse arrays and non-ordinary containers', () => {
  const symbolObject = { visible: 1 };
  symbolObject[Symbol('hidden')] = 2;
  const nonEnumerableObject = { visible: 1 };
  Object.defineProperty(nonEnumerableObject, 'hidden', { value: 2 });
  const sparseWithExtra = new Array(2);
  sparseWithExtra[1] = 'visible';
  sparseWithExtra.extra = 'hidden';
  const customArray = [1, 2];
  Object.setPrototypeOf(customArray, Object.create(Array.prototype));
  const nullPrototype = Object.assign(Object.create(null), { visible: 1 });
  const accessor = {};
  let accessorReads = 0;
  Object.defineProperty(accessor, 'visible', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 1;
    },
  });

  for (const [name, value] of [
    ['symbol extra', symbolObject],
    ['non-enumerable extra', nonEnumerableObject],
    ['sparse array plus extra', sparseWithExtra],
    ['custom Array prototype', customArray],
    ['null object prototype', nullPrototype],
    ['accessor', accessor],
    ['Date', new Date(0)],
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /PHASE5_FAULT_CANONICAL_JSON_INVALID/,
      name,
    );
  }
  assert.equal(accessorReads, 0);
});

test('canonical JSON rejects unpaired UTF-16 surrogates without rejecting valid Unicode', () => {
  assert.equal(canonicalJson({ 中文: '生态🪶' }), '{"中文":"生态🪶"}');
  for (const value of [
    '\ud800',
    '\udc00',
    { value: '\ud800' },
    { ['bad\udc00key']: true },
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /PHASE5_FAULT_CANONICAL_JSON_INVALID/,
    );
  }
});

test('exact evidence shape rejects symbol, non-enumerable and accessor extras', () => {
  const attacks = [
    ['symbol extra', (evidence) => {
      evidence[Symbol('hidden')] = 'not-canonical';
    }],
    ['non-enumerable extra', (evidence) => {
      Object.defineProperty(evidence, 'hidden', { value: 'not-canonical' });
    }],
  ];
  for (const [name, mutate] of attacks) {
    const { evidence, publicKey } = fixture();
    mutate(evidence);
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_EVIDENCE_SHAPE_INVALID/,
      name,
    );
  }

  const { evidence, publicKey } = fixture();
  let getterReads = 0;
  Object.defineProperty(evidence, 'kind', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'isolated-equivalent-spark-fault-events';
    },
  });
  assert.throws(
    () => validateSignedFaultEventEvidence(evidence, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_EVIDENCE_SHAPE_INVALID/,
  );
  assert.equal(getterReads, 0);
});

test('evidence arrays and objects must retain ordinary JSON prototypes and density', () => {
  const cases = [
    ['custom scenarioEvents Array prototype', (evidence) => {
      Object.setPrototypeOf(
        evidence.scenarioEvents,
        Object.create(Array.prototype),
      );
    }],
    ['sparse transportEvents plus extra property', (evidence) => {
      const transportEvents = new Array(2);
      transportEvents[1] = {};
      transportEvents.extra = 'hidden';
      evidence.transportEvents = transportEvents;
    }],
    ['null profile prototype', (evidence) => {
      evidence.profile = Object.assign(Object.create(null), PROFILE);
    }],
  ];
  for (const [name, mutate] of cases) {
    const { evidence, publicKey } = fixture();
    mutate(evidence);
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_(?:CANONICAL_JSON_INVALID|EVIDENCE_SHAPE_INVALID)/,
      name,
    );
  }
});

test('geometry is fixed to the production Phase 5 audio contract', () => {
  const mutations = [
    ['sampleRate', 48_000],
    ['blockFrames', 64],
    ['poolSize', 1],
    ['rowVoices', ['bass', 'pad', 'lead', 'pluck', 'lead']],
  ];
  for (const [field, value] of mutations) {
    const { evidence, publicKey } = fixture();
    evidence.geometry[field] = value;
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_GEOMETRY_INVALID/,
      field,
    );
  }
});

test('profile is an exact fixed four-client equivalent-host contract', () => {
  const mutations = [
    ['clients', 3],
    ['slowClient', 3],
    ['durationMinutes', 30.5],
    ['speciesEndpoint', 'http://localhost:8081/v1'],
    ['speciesModel', 'other'],
  ];
  for (const [field, value] of mutations) {
    const { evidence, publicKey } = fixture();
    evidence.profile[field] = value;
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_PROFILE_INVALID/,
      field,
    );
  }

  const { evidence, publicKey } = fixture();
  evidence.profile.extra = true;
  assert.throws(
    () => validateSignedFaultEventEvidence(evidence, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_PROFILE_INVALID/,
  );
});

test('both measurement clocks cover exactly 1,800,000 milliseconds', () => {
  for (const field of ['endedAtMonotonicMs', 'endedAtUnixMs']) {
    const { evidence, publicKey } = fixture();
    evidence.window[field] += 1;
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_WINDOW_INVALID/,
      field,
    );
  }
});

test('event clocks must share their window-relative offset within one millisecond', () => {
  const draftsWithinTolerance = eventDrafts();
  draftsWithinTolerance[7].atUnixMs += 1;
  const withinTolerance = buildFixtureFromDrafts(draftsWithinTolerance);
  assert.equal(
    validateSignedFaultEventEvidence(withinTolerance.evidence, {
      expectedPublicKey: withinTolerance.publicKey,
    }),
    withinTolerance.evidence,
  );

  const { evidence, publicKey } = fixture();
  evidence.scenarioEvents[7].atUnixMs += 2;
  rebindOrdinaryShaChain(evidence);
  assert.throws(
    () => validateSignedFaultEventEvidence(evidence, {
      expectedPublicKey: publicKey,
    }),
    /PHASE5_FAULT_EVENT_TIME_INVALID/,
  );
});

test('all five phases within a scenario strictly advance both clocks', () => {
  for (const field of ['atMonotonicMs', 'atUnixMs']) {
    const { evidence, publicKey } = fixture();
    evidence.scenarioEvents[2][field] = evidence.scenarioEvents[1][field];
    rebindOrdinaryShaChain(evidence);
    assert.throws(
      () => validateSignedFaultEventEvidence(evidence, {
        expectedPublicKey: publicKey,
      }),
      /PHASE5_FAULT_EVENT_TIME_INVALID/,
      field,
    );
  }
});

test('integer fields reject booleans, fractions and unsafe integers', () => {
  const invalidIntegers = [true, 1.5, Number.MAX_SAFE_INTEGER + 1];
  for (const invalid of invalidIntegers) {
    {
      const { evidence, publicKey } = fixture();
      evidence.scenarioEvents[2].atMonotonicMs = invalid;
      rebindOrdinaryShaChain(evidence);
      assert.throws(
        () => validateSignedFaultEventEvidence(evidence, {
          expectedPublicKey: publicKey,
        }),
        /PHASE5_FAULT_EVENT_TIME_INVALID/,
      );
    }
    {
      const { evidence, publicKey } = fixture();
      evidence.scenarioEvents[2].sequence = invalid;
      rebindOrdinaryShaChain(evidence);
      assert.throws(
        () => validateSignedFaultEventEvidence(evidence, {
          expectedPublicKey: publicKey,
        }),
        /PHASE5_FAULT_EVENT_SHAPE_INVALID/,
      );
    }
    {
      const { evidence, publicKey } = fixture();
      evidence.window.startedAtMonotonicMs = invalid;
      assert.throws(
        () => validateSignedFaultEventEvidence(evidence, {
          expectedPublicKey: publicKey,
        }),
        /PHASE5_FAULT_WINDOW_INVALID/,
      );
    }
    {
      const { evidence, publicKey } = fixture();
      evidence.geometry.sampleRate = invalid;
      assert.throws(
        () => validateSignedFaultEventEvidence(evidence, {
          expectedPublicKey: publicKey,
        }),
        /PHASE5_FAULT_GEOMETRY_INVALID/,
      );
    }
    {
      const { evidence, publicKey } = fixture();
      evidence.profile.clients = invalid;
      assert.throws(
        () => validateSignedFaultEventEvidence(evidence, {
          expectedPublicKey: publicKey,
        }),
        /PHASE5_FAULT_PROFILE_INVALID/,
      );
    }
  }
});
