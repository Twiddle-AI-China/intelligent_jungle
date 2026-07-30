import assert from 'node:assert/strict';

import {
  _createPhase5FaultSessionAuthority,
} from '../../src/acceptance/phase5-fault-session-authority.js';
import {
  signedFixture,
} from '../tools/phase5-fault-validation-fixture.js';

function observation(event) {
  return {
    atMonotonicMs: event.atMonotonicMs,
    atUnixMs: event.atUnixMs,
    client: event.client,
    type: event.type,
    payload: structuredClone(event.payload),
  };
}

export function createCompletedPhase5FaultSessionAuthority({
  identity,
  captureNonceBytes,
}) {
  const source = signedFixture().evidence;
  let scenarioCursor = 0;
  let transportCursor = 0;
  const authority = _createPhase5FaultSessionAuthority({
    identity: structuredClone(identity),
    captureNonceBytes: Buffer.from(captureNonceBytes),
    window: structuredClone(source.window),
    bridge: Object.freeze({
      flushTransportObservations() {
        return [];
      },
      payloadFor(plan) {
        const event = source.scenarioEvents[scenarioCursor];
        assert.equal(plan.scenario, event.scenario);
        assert.equal(plan.phase, event.phase);
        scenarioCursor += 1;
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
  for (const scenario of source.scenarioEvents) {
    while (transportCursor < scenario.transportPrefixCount) {
      authority.appendTransportObservation(observation(
        source.transportEvents[transportCursor],
      ));
      transportCursor += 1;
    }
    authority.advance();
  }
  while (transportCursor < source.transportEvents.length) {
    authority.appendTransportObservation(observation(
      source.transportEvents[transportCursor],
    ));
    transportCursor += 1;
  }
  authority.closeFaultWindow();
  return authority;
}
