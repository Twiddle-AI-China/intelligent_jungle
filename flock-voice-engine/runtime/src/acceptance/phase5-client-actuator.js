const TARGET_CLIENT = 4;
const RUNTIME_CLOSE_CODE = 1000;
const RUNTIME_CLOSE_REASON = 'PHASE5_RUNTIME_RECONNECT';

function fail(code) {
  throw new Error(code);
}

function exactClaim(value, socketKind) {
  return value !== null && typeof value === 'object'
    && value.client === TARGET_CLIENT
    && value.socketKind === socketKind
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && typeof value.clientIdentitySha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(value.clientIdentitySha256);
}

export function createPhase5ClientActuator({ recorder,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout } = {}) {
  if (!['audioPause', 'audioResume'].every(
    (name) => typeof recorder?.[name] === 'function')
      || typeof setTimer !== 'function'
      || typeof clearTimer !== 'function') {
    fail('PHASE5_CLIENT_ACTUATOR_INPUT_INVALID');
  }
  let runtime = null;
  let audioClaim = null;
  let reconnectGrant = null;
  let reconnectWaiter = null;
  let terminal = false;

  function registerRuntime(claim, connection) {
    if (terminal || !exactClaim(claim, 'runtime')
        || typeof connection?.close !== 'function'
        || typeof connection?.enqueue !== 'function'
        || runtime !== null) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_LIFECYCLE_INVALID');
    }
    runtime = Object.freeze({ claim, connection });
  }

  function unregisterRuntime(claim) {
    if (terminal || runtime === null
        || !exactClaim(claim, 'runtime')
        || claim.generation !== runtime.claim.generation) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_LIFECYCLE_INVALID');
    }
    runtime = null;
  }

  function registerAudio(claim) {
    if (terminal || !exactClaim(claim, 'audio') || audioClaim !== null) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_LIFECYCLE_INVALID');
    }
    audioClaim = Object.freeze({ ...claim });
  }

  function unregisterAudio(claim) {
    if (terminal || audioClaim === null
        || !exactClaim(claim, 'audio')
        || claim.generation !== audioClaim.generation) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_LIFECYCLE_INVALID');
    }
    audioClaim = null;
  }

  function acceptReconnectGrant(grant) {
    if (terminal || reconnectGrant !== null
        || grant?.client !== TARGET_CLIENT
        || grant?.socketKind !== 'runtime'
        || !Number.isSafeInteger(grant.generation)
        || grant.generation <= 1
        || typeof grant.capability !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/u.test(grant.capability)) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_GRANT_INVALID');
    }
    reconnectGrant = Object.freeze({ ...grant });
    if (reconnectWaiter !== null) {
      const waiter = reconnectWaiter;
      reconnectWaiter = null;
      clearTimer(waiter.timer);
      const value = reconnectGrant;
      reconnectGrant = null;
      waiter.resolve(value);
    }
  }

  function disconnectRuntime(...args) {
    if (args.length !== 0 || terminal || runtime === null) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_ACTION_INVALID');
    }
    runtime.connection.close(RUNTIME_CLOSE_CODE, RUNTIME_CLOSE_REASON);
  }

  function saturateEgress(...args) {
    if (args.length !== 0 || terminal || runtime === null) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_ACTION_INVALID');
    }
    let accepted = 0;
    for (let index = 0; index <= 256; index += 1) {
      if (runtime.connection.enqueue(Object.freeze({
        type: 'phase5.queue-pressure',
        protocolVersion: 1,
        sequence: index + 1,
      }))) accepted += 1;
    }
    if (accepted !== 256) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_PRESSURE_INVALID');
    }
  }

  function waitRuntimeReconnectGrant(...args) {
    if (args.length !== 0 || terminal || reconnectWaiter !== null) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_GRANT_INVALID');
    }
    if (reconnectGrant !== null) {
      const value = reconnectGrant;
      reconnectGrant = null;
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        if (reconnectWaiter === null) return;
        reconnectWaiter = null;
        terminal = true;
        reject(new Error('PHASE5_CLIENT_ACTUATOR_GRANT_TIMEOUT'));
      }, 5_000);
      reconnectWaiter = { resolve, timer };
    });
  }

  function recordAudioCompletion(sequence) {
    if (terminal || audioClaim === null || ![5, 6].includes(sequence)) {
      terminal = true;
      fail('PHASE5_CLIENT_ACTUATOR_COMPLETION_INVALID');
    }
    if (sequence === 5) recorder.audioPause(audioClaim);
    else recorder.audioResume(audioClaim);
  }

  return Object.freeze({
    registerRuntime,
    unregisterRuntime,
    registerAudio,
    unregisterAudio,
    acceptReconnectGrant,
    disconnectRuntime,
    saturateEgress,
    waitRuntimeReconnectGrant,
    recordAudioCompletion,
  });
}
