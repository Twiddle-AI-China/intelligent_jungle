import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateSignedFaultEventEvidence,
} from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  signedFixture,
} from '../tools/phase5-fault-validation-fixture.js';

const MODULE_URL = new URL(
  '../../src/acceptance/phase5-fault-session-authority.js',
  import.meta.url,
);

const SCENARIOS = Object.freeze([
  'worker-crash-restart',
  'runtime-reconnect',
  'slow-client',
  'queue-pressure',
  'agent-timeout',
  'agent-malformed-response',
  'audio-epoch-discontinuity',
]);
const PHASES = Object.freeze([
  'before',
  'fault-action',
  'fault-observed',
  'recovery-action',
  'recovery-observed',
]);
const ACTION_PHASES = new Set(['fault-action', 'recovery-action']);

async function loadAuthority() {
  return import(MODULE_URL.href);
}

const CAPTURE_NONCE_BYTES = Buffer.alloc(32, 0x5a);
const RAW_MANIFEST_SHA256 = '9'.repeat(64);

function authorityFixture(module, { eventIndex = 0, asyncPayload = false } = {}) {
  const source = signedFixture().evidence;
  let cursor = eventIndex;
  const commits = [];
  const dispatches = [];
  const flushes = [];
  const bridge = Object.freeze({
    flushTransportObservations() {
      flushes.push(cursor);
      return [];
    },
    payloadFor(plan) {
      const event = source.scenarioEvents[cursor];
      assert.equal(plan.scenario, event.scenario);
      assert.equal(plan.phase, event.phase);
      cursor += 1;
      const value = {
        atMonotonicMs: event.atMonotonicMs,
        atUnixMs: event.atUnixMs,
        payload: structuredClone(event.payload),
      };
      return asyncPayload ? Promise.resolve(value) : value;
    },
    commitSignedAction(bytes, sequence) {
      commits.push([Buffer.from(bytes), sequence]);
    },
    dispatchFixedInstruction(sequence) {
      assert.equal(commits.length, dispatches.length + 1);
      dispatches.push(sequence);
    },
  });
  const authority = module._createPhase5FaultSessionAuthority({
    identity: {
      runId: source.runId,
      challenge: source.challenge,
      release: structuredClone(source.release),
      geometry: structuredClone(source.geometry),
      profile: structuredClone(source.profile),
    },
    captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
    window: structuredClone(source.window),
    bridge,
  });
  return { authority, source, commits, dispatches, flushes };
}

function observation(event) {
  return {
    atMonotonicMs: event.atMonotonicMs,
    atUnixMs: event.atUnixMs,
    client: event.client,
    type: event.type,
    payload: structuredClone(event.payload),
  };
}

test('candidate owns a dedicated fault-session authority module', async () => {
  const module = await loadAuthority();
  assert.equal(typeof module.createPhase5FaultSessionAuthority, 'function');
  assert.equal(typeof module.Phase5FaultSessionAuthorityError, 'function');
});

test('async predicate keeps advance exclusive until its owned state resolves', async () => {
  const module = await loadAuthority();
  const value = authorityFixture(module, { asyncPayload: true });
  const pending = value.authority.advance();
  assert.equal(typeof pending?.then, 'function');
  assert.throws(() => value.authority.advance(),
    /PHASE5_FAULT_SESSION_ADVANCE_CONCURRENT/u);
  await assert.rejects(pending);
});

test('the frozen plan is exactly 35 phases with action sequence 1 through 14',
    async () => {
      const { PHASE5_FAULT_SESSION_PLAN } = await loadAuthority();
      assert.equal(Object.isFrozen(PHASE5_FAULT_SESSION_PLAN), true);
      assert.deepEqual(
        PHASE5_FAULT_SESSION_PLAN.map(({ scenario, phase }) => ({
          scenario,
          phase,
        })),
        SCENARIOS.flatMap((scenario) => PHASES.map((phase) => ({
          scenario,
          phase,
        }))),
      );
      assert.deepEqual(
        PHASE5_FAULT_SESSION_PLAN
          .filter(({ phase }) => ACTION_PHASES.has(phase))
          .map(({ actionSequence }) => actionSequence),
        Array.from({ length: 14 }, (_, index) => index + 1),
      );
    });

test('authority exposes only owned observation, advance, close and capture capabilities',
    async () => {
      const source = await readFile(MODULE_URL, 'utf8');
      assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:sign|setClock|setTarget)/u);
      assert.doesNotMatch(source, /privateKey\s*:/u);
      assert.doesNotMatch(source, /caller(?:Key|Signer|Clock)/u);
      assert.match(source, /appendTransportObservation/u);
      assert.match(source, /advance/u);
      assert.match(source, /closeFaultWindow/u);
      assert.match(source, /finalizeCapture/u);
    });

test('generic actuator and signer inputs are rejected before any owned effect',
    async () => {
      const { createPhase5FaultSessionAuthority } = await loadAuthority();
      const forbidden = [
        'operation', 'target', 'script', 'argv', 'pid', 'container',
        'socketPath', 'providerUrl', 'fixture', 'privateKey', 'signer',
        'clock',
      ];
      for (const name of forbidden) {
        let getterCalls = 0;
        const options = {};
        Object.defineProperty(options, name, {
          enumerable: true,
          get() {
            getterCalls += 1;
            return 'attacker-controlled';
          },
        });
        assert.throws(
          () => createPhase5FaultSessionAuthority(options),
          /PHASE5_FAULT_SESSION_INPUT_INVALID/u,
          name,
        );
        assert.equal(getterCalls, 0, name);
      }
    });

test('advance is a zero-argument capability and malformed first use is terminal',
    async () => {
      const module = await loadAuthority();
      const { authority, commits, dispatches } = authorityFixture(module);

      assert.throws(
        () => authority.advance({ operation: 'kill', target: 'anything' }),
        /PHASE5_FAULT_SESSION_ADVANCE_INVALID/u,
      );
      assert.deepEqual(commits, []);
      assert.deepEqual(dispatches, []);
      assert.throws(
        () => authority.advance(),
        /PHASE5_FAULT_SESSION_ALREADY_TERMINAL/u,
      );
    });

test('deferred activation preserves the bootstrap admission signer', async () => {
  const module = await loadAuthority();
  const source = signedFixture().evidence;
  let cursor = 0;
  const authority = module.createPhase5FaultSessionAuthority({
    identity: {
      runId: source.runId,
      challenge: source.challenge,
      release: structuredClone(source.release),
      geometry: structuredClone(source.geometry),
      profile: structuredClone(source.profile),
    },
    captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
  });
  const before = authority.getAdmission();
  module.activatePhase5FaultSessionAuthority(authority, {
    window: structuredClone(source.window),
    bridge: Object.freeze({
      flushTransportObservations() { return []; },
      payloadFor(plan) {
        const event = source.scenarioEvents[cursor];
        assert.equal(plan.scenario, event.scenario);
        assert.equal(plan.phase, event.phase);
        cursor += 1;
        return {
          atMonotonicMs: event.atMonotonicMs,
          atUnixMs: event.atUnixMs,
          payload: structuredClone(event.payload),
        };
      },
      commitSignedAction() {},
      dispatchFixedInstruction() {},
    }),
  });
  assert.deepEqual(authority.getAdmission(), before);
  const first = authority.advance();
  assert.equal(first.sequence, 1);
});

test('transport prefix, closure and capture proof use one admission signer',
    async () => {
      const module = await loadAuthority();
      const value = authorityFixture(module);
      let transportCursor = 0;
      for (const expected of value.source.scenarioEvents) {
        while (transportCursor < expected.transportPrefixCount) {
          value.authority.appendTransportObservation(observation(
            value.source.transportEvents[transportCursor],
          ));
          transportCursor += 1;
        }
        const actual = value.authority.advance();
        assert.equal(actual.transportPrefixCount, transportCursor);
        assert.equal(actual.scenario, expected.scenario);
        assert.equal(actual.phase, expected.phase);
      }
      while (transportCursor < value.source.transportEvents.length) {
        value.authority.appendTransportObservation(observation(
          value.source.transportEvents[transportCursor],
        ));
        transportCursor += 1;
      }
      const admission = value.authority.getAdmission();
      const faultEventsBytes = value.authority.closeFaultWindow();
      const faultEvents = JSON.parse(faultEventsBytes.toString('utf8'));
      const publicKey = createPublicKey({
        key: Buffer.from(admission.trustedSignerSpkiDerBase64, 'base64'),
        type: 'spki',
        format: 'der',
      });
      validateSignedFaultEventEvidence(faultEvents, {
        expectedPublicKey: publicKey,
      });
      assert.equal(
        faultEvents.signer.publicKeySpkiSha256,
        admission.signerSpkiSha256,
      );
      assert.deepEqual(
        value.commits.map((entry) => entry[1]),
        Array.from({ length: 14 }, (_, index) => index + 1),
      );
      assert.deepEqual(
        value.dispatches,
        Array.from({ length: 14 }, (_, index) => index + 1),
      );
      assert.equal(value.flushes.length, 35);
      for (let index = 0; index < value.commits.length; index += 1) {
        assert.equal(
          JSON.parse(value.commits[index][0].toString('utf8')).signature,
          faultEvents.scenarioEvents.filter(
            ({ phase }) => phase.endsWith('action'),
          )[index].signature,
        );
      }

      const capture = value.authority.finalizeCapture(RAW_MANIFEST_SHA256);
      assert.deepEqual(capture.faultEventsBytes, faultEventsBytes);
      assert.equal(
        capture.runBinding.signerSpkiSha256,
        admission.signerSpkiSha256,
      );
      assert.throws(
        () => value.authority.finalizeCapture(RAW_MANIFEST_SHA256),
        /PHASE5_FAULT_SESSION_ALREADY_USED/u,
      );
      assert.throws(
        () => value.authority.appendTransportObservation(observation(
          value.source.transportEvents.at(-1),
        )),
        /PHASE5_FAULT_SESSION_ALREADY_TERMINAL/u,
      );
    });

test('equal-time transport backfill permanently consumes the authority',
    async () => {
      const module = await loadAuthority();
      const value = authorityFixture(module);
      const first = value.source.scenarioEvents[0];
      for (let index = 0; index < first.transportPrefixCount; index += 1) {
        value.authority.appendTransportObservation(observation(
          value.source.transportEvents[index],
        ));
      }
      value.authority.advance();
      assert.throws(
        () => value.authority.appendTransportObservation({
          atMonotonicMs: first.atMonotonicMs,
          atUnixMs: first.atUnixMs,
          client: 0,
          type: 'worker.sample',
          payload: {},
        }),
        /PHASE5_FAULT_SESSION_TRANSPORT_BACKFILL/u,
      );
      assert.throws(
        () => value.authority.advance(),
        /PHASE5_FAULT_SESSION_ALREADY_TERMINAL/u,
      );
    });
