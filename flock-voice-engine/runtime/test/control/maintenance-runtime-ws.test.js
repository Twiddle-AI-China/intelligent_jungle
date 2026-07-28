import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeWsGateway } from '../../src/api/runtime-ws.js';

const originPolicy = Object.freeze({
  authorize: () => Object.freeze({ allowed: true, branch: 'browser' }),
});

function command(name, payload, commandId = name) {
  return { type: 'command', protocolVersion: 1, commandId, name, payload,
    worldGeneration: 'world-a', baseRevision: 0 };
}

test('maintenance authenticate and legacy take stay out of world command routing', async () => {
  const sent = []; const ownerRequests = []; let worldCommands = 0;
  const gateway = createRuntimeWsGateway({ getSession: () => null,
    originPolicy,
    maintenanceAuth: { authenticate: ({ credential }) => ({ ok: credential === 'x'.repeat(32),
      code: 'ok', maintenanceToken: 'grant-token' }), revokeConnection() {} },
    audioOwner: { async takeLegacy(request) { ownerRequests.push(request);
      return { ok: true, code: 'ok', leaseToken: 'lease-token' }; } } });
  const session = { worldGeneration: 'world-a', revision: 0,
    executeCommand() { worldCommands += 1; } };
  const egress = { enqueue(value) { sent.push(value); return true; } };
  await gateway.routeCommand({ session, clientId: 'maintenance-client', generation: 7, egress,
    command: command('maintenance.authenticate', { credential: 'x'.repeat(32) }) });
  await gateway.routeCommand({ session, clientId: 'maintenance-client', generation: 7, egress,
    command: command('legacy.take', { maintenanceToken: 'grant-token',
      decoderSessionId: 'decoder-session' }) });
  assert.equal(worldCommands, 0);
  assert.equal(sent[0].maintenanceToken, 'grant-token');
  assert.equal(sent[1].leaseToken, 'lease-token');
  assert.deepEqual(ownerRequests[0], { maintenanceToken: 'grant-token',
    decoderSessionId: 'decoder-session', clientId: 'maintenance-client', connectionGeneration: '7' });
});

test('maintenance commands allow stale anchors but reject future revisions and malformed identity', async () => {
  const sent = [];
  const gateway = createRuntimeWsGateway({ getSession: () => null,
    originPolicy,
    maintenanceAuth: { authenticate: () => ({ ok: false, code: 'maintenance_denied' }) },
    audioOwner: {} });
  const session = { worldGeneration: 'world-a', revision: 2 };
  const egress = { enqueue(value) { sent.push(value); return true; } };
  await gateway.routeCommand({ session, clientId: 'm', generation: 1, egress,
    command: { ...command('maintenance.authenticate', { credential: 'x'.repeat(32) }, ''),
      baseRevision: 2 } });
  await gateway.routeCommand({ session, clientId: 'm', generation: 1, egress,
    command: { ...command('maintenance.authenticate', { credential: 'x'.repeat(32) }),
      baseRevision: 1 } });
  await gateway.routeCommand({ session, clientId: 'm', generation: 1, egress,
    command: { ...command('maintenance.authenticate', { credential: 'x'.repeat(32) }),
      baseRevision: 3 } });
  assert.deepEqual(sent.map((value) => value.code),
    ['INVALID_COMMAND', 'maintenance_denied', 'INVALID_COMMAND']);
});
