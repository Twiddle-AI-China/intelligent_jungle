import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('candidate owns a dedicated fault-session authority module', async () => {
  const module = await loadAuthority();
  assert.equal(typeof module.createPhase5FaultSessionAuthority, 'function');
  assert.equal(typeof module.Phase5FaultSessionAuthorityError, 'function');
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
      const { createPhase5FaultSessionAuthorityForContractTest } =
        await loadAuthority();
      const effects = [];
      const authority = createPhase5FaultSessionAuthorityForContractTest({
        onOwnedEffect: (effect) => effects.push(effect),
      });

      assert.throws(
        () => authority.advance({ operation: 'kill', target: 'anything' }),
        /PHASE5_FAULT_SESSION_ADVANCE_INVALID/u,
      );
      assert.deepEqual(effects, []);
      assert.throws(
        () => authority.advance(),
        /PHASE5_FAULT_SESSION_ALREADY_TERMINAL/u,
      );
    });

test('transport prefix and two-stage signer lifecycle fail closed', async () => {
  const { exercisePhase5FaultSessionContract } = await loadAuthority();
  const result = exercisePhase5FaultSessionContract();
  assert.deepEqual(result, {
    flushBeforeEveryScenarioSignature: true,
    equalTimeOmittedTransportRejected: true,
    prefixBackfillRejected: true,
    appendAfterClosureRejected: true,
    closureUsesAdmissionSigner: true,
    captureUsesAdmissionSigner: true,
    captureAllowedExactlyOnceAfterClosure: true,
    signingRejectedAfterCapture: true,
    replayRejected: true,
    skippedPhaseRejected: true,
    concurrentAdvanceRejected: true,
  });
});
