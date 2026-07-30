import { createHash } from 'node:crypto';

import {
  decodePhase5FaultControlCompletion,
  encodePhase5FaultControlInstruction,
} from './phase5-fault-control-protocol.js';

const RELAY_SEQUENCES = new Set([1, 4, 5, 6, 8, 13]);
const DISPATCH_SEQUENCES = Object.freeze([1, 3, 4, 5, 6, 7, 8, 13, 14]);

function fail(code) {
  throw new Error(code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createPhase5FaultInstructionChannel({ clientActuator } = {}) {
  if (![
    'disconnectRuntime', 'saturateEgress',
    'waitRuntimeReconnectGrant', 'recordAudioCompletion',
  ].every((name) => typeof clientActuator?.[name] === 'function')) {
    fail('PHASE5_FAULT_INSTRUCTION_CHANNEL_INPUT_INVALID');
  }
  let sendFrame = null;
  let pending = null;
  let terminal = false;
  let dispatchCursor = 0;

  function bindTransport(value) {
    if (terminal || sendFrame !== null || typeof value !== 'function') {
      terminal = true;
      fail('PHASE5_FAULT_INSTRUCTION_CHANNEL_BIND_INVALID');
    }
    sendFrame = value;
  }

  async function dispatch(instruction, signedEventBytes) {
    const sequence = instruction?.sequence;
    if (terminal || pending !== null || sendFrame === null
        || !Buffer.isBuffer(signedEventBytes)
        || signedEventBytes.byteLength === 0
        || instruction?.schemaVersion !== 1
        || instruction?.kind !== 'phase5-fixed-instruction'
        || Reflect.ownKeys(instruction).length !== 4
        || !Object.hasOwn(instruction, 'plannedAudioEpoch')
        || sequence !== DISPATCH_SEQUENCES[dispatchCursor]) {
      terminal = true;
      fail('PHASE5_FAULT_INSTRUCTION_CHANNEL_DISPATCH_INVALID');
    }
    dispatchCursor += 1;
    if (sequence === 3) {
      clientActuator.disconnectRuntime();
      return;
    }
    if (sequence === 7) {
      clientActuator.saturateEgress();
      return;
    }
    if (sequence === 14) return;
    if (!RELAY_SEQUENCES.has(sequence)) {
      terminal = true;
      fail('PHASE5_FAULT_INSTRUCTION_CHANNEL_DISPATCH_INVALID');
    }
    let capability = null;
    if (sequence === 4 || sequence === 8) {
      capability = (await clientActuator.waitRuntimeReconnectGrant())
        .capability;
    }
    const actionEventSha256 = sha256(signedEventBytes);
    const frame = encodePhase5FaultControlInstruction({
      schemaVersion: 1,
      kind: 'phase5-fixed-instruction',
      sequence,
      actionEventBase64: signedEventBytes.toString('base64'),
      runtimeCapability: capability,
    });
    return new Promise((resolve, reject) => {
      pending = { sequence, actionEventSha256, resolve, reject };
      try {
        sendFrame(frame);
      } catch (error) {
        pending = null;
        terminal = true;
        reject(error);
      }
    });
  }

  function acceptCompletion(bytes) {
    if (terminal || pending === null || !Buffer.isBuffer(bytes)) {
      terminal = true;
      fail('PHASE5_FAULT_INSTRUCTION_CHANNEL_COMPLETION_INVALID');
    }
    let completion;
    try {
      completion = decodePhase5FaultControlCompletion(bytes);
    } catch (error) {
      terminal = true;
      const current = pending;
      pending = null;
      current.reject(error);
      throw error;
    }
    if (completion.sequence !== pending.sequence
        || completion.actionEventSha256 !== pending.actionEventSha256) {
      terminal = true;
      const current = pending;
      pending = null;
      const error = new Error(
        'PHASE5_FAULT_INSTRUCTION_CHANNEL_COMPLETION_INVALID',
      );
      current.reject(error);
      throw error;
    }
    const current = pending;
    pending = null;
    if (completion.sequence === 5 || completion.sequence === 6) {
      clientActuator.recordAudioCompletion(completion.sequence);
    }
    current.resolve();
  }

  function close(...args) {
    if (args.length !== 0) {
      terminal = true;
      fail('PHASE5_FAULT_INSTRUCTION_CHANNEL_INPUT_INVALID');
    }
    terminal = true;
    const current = pending;
    pending = null;
    current?.reject(new Error('PHASE5_FAULT_INSTRUCTION_CHANNEL_CLOSED'));
  }

  return Object.freeze({
    instructionSink: Object.freeze({ dispatch }),
    bindTransport,
    acceptCompletion,
    close,
  });
}
