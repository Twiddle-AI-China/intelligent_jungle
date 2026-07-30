import { types } from 'node:util';

import { createPhase5FaultControlClient } from './phase5-fault-control-client.mjs';
import {
  projectPhase5ClientObservationsTransport,
} from './phase5-fault-transport-projection.mjs';

const DEPENDENCIES = Object.freeze([
  'controllerSession', 'openClients', 'sampleWindow', 'finalizeAndPublish',
]);

function fail(code) { throw new Error(code); }

function exactDependencies(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === DEPENDENCIES.length
    && DEPENDENCIES.every((name) => Object.hasOwn(value, name));
}

export function createPhase5SoakOrchestrator(options = {}) {
  if (arguments.length !== 1 || !exactDependencies(options)
      || !['receiveAdmission', 'sendRequestBytes'].every(
        (name) => typeof options.controllerSession?.[name] === 'function')
      || !['openClients', 'sampleWindow', 'finalizeAndPublish'].every(
        (name) => typeof options[name] === 'function')) {
    fail('PHASE5_SOAK_ORCHESTRATOR_INPUT_INVALID');
  }
  let state = 'idle';

  async function run(...args) {
    if (args.length !== 0 || state !== 'idle') {
      state = 'terminal';
      fail('PHASE5_SOAK_ORCHESTRATOR_STATE_INVALID');
    }
    state = 'running';
    let clients = null;
    try {
      const admitted = await options.controllerSession.receiveAdmission();
      clients = await options.openClients(admitted);
      if (!clients || typeof clients !== 'object'
          || typeof clients.handleInstruction !== 'function'
          || typeof clients.close !== 'function') {
        fail('PHASE5_SOAK_CLIENTS_INVALID');
      }
      const faultClient = createPhase5FaultControlClient({
        sendRequestBytes: options.controllerSession.sendRequestBytes,
      });
      const sampling = Promise.resolve(options.sampleWindow({
        admitted,
        clients,
      }));
      for (let sequence = 1; sequence <= 35; sequence += 1) {
        await faultClient.advance();
      }
      const sampled = await sampling;
      const closed = await faultClient.closeWindow();
      const faultEventsBytes = Buffer.from(closed.faultEventsBase64, 'base64');
      if (faultEventsBytes.byteLength === 0
          || faultEventsBytes.toString('base64') !== closed.faultEventsBase64) {
        fail('PHASE5_SOAK_FAULT_CLOSURE_INVALID');
      }
      let faultEvidence;
      try { faultEvidence = JSON.parse(faultEventsBytes); } catch {
        fail('PHASE5_SOAK_FAULT_CLOSURE_INVALID');
      }
      const signedClientProjection =
        projectPhase5ClientObservationsTransport(faultEvidence);
      const result = await options.finalizeAndPublish({
        admitted,
        clients,
        sampled,
        faultEventsBytes,
        signedClientProjection,
      });
      state = 'complete';
      await clients.close();
      clients = null;
      return result;
    } catch (error) {
      state = 'terminal';
      if (clients !== null) {
        try { await clients.close(); } catch {}
      }
      throw error;
    }
  }

  return Object.freeze({ run });
}
