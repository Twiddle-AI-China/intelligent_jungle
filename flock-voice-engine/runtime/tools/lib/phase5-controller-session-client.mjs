import { createHash } from 'node:crypto';
import { Socket } from 'node:net';

import {
  decodePhase5FaultControlInstruction,
  decodePhase5FaultControlResponse,
  encodePhase5FaultControlCompletion,
  MAX_PHASE5_FAULT_CONTROL_RESPONSE_BYTES,
} from '../../src/acceptance/phase5-fault-control-protocol.js';
import { canonicalJson } from './phase5-lease-evidence.mjs';
import { ownBindingAndWindow } from './phase5-raw-common.mjs';

function fail(code) {
  throw new Error(code);
}

export function createPhase5ControllerFdTransport(fd) {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    fail('PHASE5_CONTROLLER_SESSION_FD_INVALID');
  }
  let socket;
  try {
    socket = new Socket({ fd, readable: true, writable: true });
  } catch {
    fail('PHASE5_CONTROLLER_SESSION_FD_INVALID');
  }
  let buffered = Buffer.alloc(0);
  let terminal = false;
  const frames = [];
  const waiters = [];
  const rejectAll = (error) => {
    terminal = true;
    while (waiters.length > 0) waiters.shift().reject(error);
  };
  socket.on('data', (chunk) => {
    if (terminal || !Buffer.isBuffer(chunk)) return;
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.byteLength > MAX_PHASE5_FAULT_CONTROL_RESPONSE_BYTES) {
      rejectAll(new Error('PHASE5_CONTROLLER_SESSION_FRAME_INVALID'));
      socket.destroy();
      return;
    }
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      const frame = Buffer.from(buffered.subarray(0, newline + 1));
      buffered = Buffer.from(buffered.subarray(newline + 1));
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame); else frames.push(frame);
    }
  });
  socket.on('error', () => rejectAll(
    new Error('PHASE5_CONTROLLER_SESSION_TRANSPORT_FAILED'),
  ));
  socket.on('close', () => {
    if (!terminal) rejectAll(new Error(
      buffered.byteLength === 0
        ? 'PHASE5_CONTROLLER_SESSION_CLOSED'
        : 'PHASE5_CONTROLLER_SESSION_FRAME_INVALID',
    ));
  });
  async function sendFrame(bytes) {
    if (terminal || !Buffer.isBuffer(bytes) || bytes.byteLength < 2
        || bytes.at(-1) !== 0x0a
        || bytes.byteLength > MAX_PHASE5_FAULT_CONTROL_RESPONSE_BYTES) {
      fail('PHASE5_CONTROLLER_SESSION_TRANSPORT_FAILED');
    }
    await new Promise((resolve, reject) => {
      socket.write(Buffer.from(bytes), (error) => {
        if (error) { rejectAll(error); reject(error); } else resolve();
      });
    });
  }
  function receiveFrame() {
    if (frames.length > 0) return Promise.resolve(frames.shift());
    if (terminal) return Promise.reject(new Error(
      'PHASE5_CONTROLLER_SESSION_CLOSED',
    ));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }
  function close() {
    if (!terminal) {
      terminal = true;
      socket.end();
    }
  }
  return Object.freeze({ sendFrame, receiveFrame, close });
}

function exactKeys(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function decodeCanonicalLine(bytes, maxBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2
      || bytes.byteLength > maxBytes || bytes.at(-1) !== 0x0a) {
    fail('PHASE5_CONTROLLER_SESSION_FRAME_INVALID');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, -1)));
  } catch {
    fail('PHASE5_CONTROLLER_SESSION_FRAME_INVALID');
  }
  if (`${canonicalJson(value)}\n` !== bytes.toString('utf8')) {
    fail('PHASE5_CONTROLLER_SESSION_FRAME_INVALID');
  }
  return value;
}

function validCapability(value, client) {
  return exactKeys(value, [
    'client', 'clientIdentitySha256',
    'runtimeCapability', 'runtimeGeneration',
    'audioCapability', 'audioGeneration',
  ]) && value.client === client
    && typeof value.clientIdentitySha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(value.clientIdentitySha256)
    && typeof value.runtimeCapability === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(value.runtimeCapability)
    && value.runtimeGeneration === 1
    && typeof value.audioCapability === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(value.audioCapability)
    && value.audioGeneration === 1;
}

export function createPhase5ControllerSessionClient({
  sendFrame,
  receiveFrame,
  handleClientInstruction,
} = {}) {
  if (typeof sendFrame !== 'function' || typeof receiveFrame !== 'function'
      || typeof handleClientInstruction !== 'function') {
    fail('PHASE5_CONTROLLER_SESSION_INPUT_INVALID');
  }
  let admitted = false;
  let terminal = false;
  let busy = false;

  async function receiveAdmission(...args) {
    if (args.length !== 0 || admitted || terminal || busy) {
      terminal = true;
      fail('PHASE5_CONTROLLER_SESSION_STATE_INVALID');
    }
    busy = true;
    try {
      const value = decodeCanonicalLine(await receiveFrame(), 16 * 1024);
      if (!exactKeys(value, [
        'schemaVersion', 'kind', 'descriptor', 'clientCapabilities',
      ]) || value.schemaVersion !== 1
          || value.kind !== 'phase5-controller-session-admission'
          || !exactKeys(value.descriptor, ['binding', 'window'])
          || !Array.isArray(value.clientCapabilities)
          || value.clientCapabilities.length !== 4
          || !value.clientCapabilities.every((item, index) => (
            validCapability(item, index + 1)
          ))) {
        fail('PHASE5_CONTROLLER_SESSION_ADMISSION_INVALID');
      }
      const descriptor = ownBindingAndWindow(
        value.descriptor.binding,
        value.descriptor.window,
        'PHASE5_CONTROLLER_SESSION_ADMISSION_INVALID',
      );
      admitted = true;
      return Object.freeze({
        descriptor,
        clientCapabilities: Object.freeze(value.clientCapabilities.map(
          (item) => Object.freeze({ ...item }),
        )),
      });
    } catch (error) {
      terminal = true;
      throw error;
    } finally {
      busy = false;
    }
  }

  async function sendRequestBytes(bytes) {
    if (!admitted || terminal || busy || !Buffer.isBuffer(bytes)) {
      terminal = true;
      fail('PHASE5_CONTROLLER_SESSION_STATE_INVALID');
    }
    busy = true;
    try {
      await sendFrame(Buffer.from(bytes));
      while (true) {
        const incoming = await receiveFrame();
        try {
          decodePhase5FaultControlResponse(incoming);
          return Buffer.from(incoming);
        } catch {
          // The only other legal controller frame is a fixed instruction.
        }
        const instruction = decodePhase5FaultControlInstruction(incoming);
        const accepted = await handleClientInstruction(
          Object.freeze({ ...instruction }),
        );
        if (accepted !== true) {
          fail('PHASE5_CONTROLLER_SESSION_INSTRUCTION_REJECTED');
        }
        const actionBytes = Buffer.from(
          instruction.actionEventBase64,
          'base64',
        );
        await sendFrame(encodePhase5FaultControlCompletion({
          schemaVersion: 1,
          kind: 'phase5-fixed-instruction-complete',
          sequence: instruction.sequence,
          actionEventSha256: createHash('sha256')
            .update(actionBytes).digest('hex'),
          accepted: true,
        }));
      }
    } catch (error) {
      terminal = true;
      throw error;
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ receiveAdmission, sendRequestBytes });
}
