import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceAuth } from '../../src/control/maintenance-auth.js';

test('maintenance secret fails closed and grants bind exact client generation and resource', () => {
  const unavailable = createMaintenanceAuth({ readSecret() { throw new Error('missing'); } });
  assert.equal(unavailable.enabled, false);
  assert.equal(unavailable.authenticate({ credential: 'x' }).code, 'maintenance_unavailable');
  assert.equal(createMaintenanceAuth({ readSecret: () => Buffer.from('x'.repeat(31)) }).enabled, false);

  const auth = createMaintenanceAuth({ readSecret: () => Buffer.from('x'.repeat(32)),
    tokenFactory: () => 'maintenance-token' });
  assert.equal(auth.authenticate({ credential: 'y'.repeat(32), clientId: 'm',
    connectionGeneration: 'g' }).code, 'maintenance_denied');
  const grant = auth.authenticate({ credential: 'x'.repeat(32), clientId: 'm',
    connectionGeneration: 'g' });
  assert.equal(grant.ok, true);
  assert.equal(auth.verify({ maintenanceToken: grant.maintenanceToken, clientId: 'm',
    connectionGeneration: 'g', resource: 'legacy-audio' }), true);
  assert.equal(auth.verify({ maintenanceToken: grant.maintenanceToken, clientId: 'm',
    connectionGeneration: 'other', resource: 'legacy-audio' }), false);
  assert.equal(auth.verify({ maintenanceToken: grant.maintenanceToken, clientId: 'm',
    connectionGeneration: 'g', resource: 'latent:bass' }), false);
  assert.equal(auth.authenticate({ credential: 'x'.repeat(32), clientId: 'm',
    connectionGeneration: 'g' }).code, 'maintenance_token_unavailable');
  auth.revokeConnection({ clientId: 'm', connectionGeneration: 'g' });
  assert.equal(auth.verify({ maintenanceToken: grant.maintenanceToken, clientId: 'm',
    connectionGeneration: 'g', resource: 'legacy-audio' }), false);
});
