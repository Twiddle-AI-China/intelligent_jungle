#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const [action, decoderSessionId, leaseToken] = process.argv.slice(2);
if (!['take', 'hold', 'heartbeat', 'release'].includes(action) || !decoderSessionId
    || (!['take', 'hold'].includes(action) && !leaseToken)) {
  process.stderr.write('usage: legacy-lease.mjs hold|take <decoderSessionId> | heartbeat|release <decoderSessionId> <leaseToken>\n');
  process.exitCode = 2;
} else {
  const baseUrl = process.env.FLOCK_RUNTIME_URL ?? 'http://127.0.0.1:18090';
  const allowedOrigin = process.env.FLOCK_RUNTIME_ORIGIN ?? 'http://127.0.0.1:4193';
  const target = new URL(baseUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.port !== '18090'
      || target.username || target.password) {
    throw new Error('MAINTENANCE_RUNTIME_MUST_BE_LOOPBACK_18090');
  }
  if (allowedOrigin !== 'http://127.0.0.1:4193') {
    throw new Error('MAINTENANCE_ORIGIN_INVALID');
  }
  const credential = await readFile('/run/secrets/flock-maintenance-token', 'utf8');
  const bootstrap = await fetch(new URL('/api/v1/bootstrap', baseUrl), {
    headers: { Origin: allowedOrigin },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`BOOTSTRAP_HTTP_${response.status}`);
    return response.json();
  });
  const socketUrl = new URL('/api/v1/runtime', baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl, { origin: allowedOrigin });
  const pending = new Map();
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'command.result') pending.get(frame.commandId)?.(frame);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientId: bootstrap.clientId,
    bootstrapToken: bootstrap.bootstrapToken, worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision, lastEventSeq: bootstrap.eventSeq }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('READY_TIMEOUT')), 5000);
    const listener = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') { clearTimeout(timer); socket.off('message', listener); resolve(); }
    };
    socket.on('message', listener);
  });
  const command = (name, payload) => new Promise((resolve, reject) => {
    const commandId = randomUUID();
    const timer = setTimeout(() => { pending.delete(commandId); reject(new Error('COMMAND_TIMEOUT')); }, 10000);
    pending.set(commandId, (value) => { clearTimeout(timer); pending.delete(commandId); resolve(value); });
    socket.send(JSON.stringify({ type: 'command', protocolVersion: 1, commandId, name, payload,
      worldGeneration: bootstrap.worldGeneration, baseRevision: bootstrap.revision }));
  });
  const authenticated = await command('maintenance.authenticate', { credential });
  if (!authenticated.accepted) throw new Error(authenticated.code);
  const operation = action === 'hold' ? 'take' : action;
  const result = await command(`legacy.${operation}`, { maintenanceToken: authenticated.maintenanceToken,
    decoderSessionId, ...(leaseToken ? { leaseToken } : {}) });
  if (!result.accepted) throw new Error(result.code);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (action === 'hold') {
    let stop;
    const stopped = new Promise((resolve) => { stop = resolve; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    while (true) {
      const outcome = await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('heartbeat'), 750)),
        stopped.then(() => 'stop'),
      ]);
      if (outcome === 'stop') break;
      const heartbeat = await command('legacy.heartbeat', {
        maintenanceToken: authenticated.maintenanceToken,
        decoderSessionId, leaseToken: result.leaseToken,
      });
      if (!heartbeat.accepted) throw new Error(heartbeat.code);
    }
    const released = await command('legacy.release', {
      maintenanceToken: authenticated.maintenanceToken,
      decoderSessionId, leaseToken: result.leaseToken,
    });
    if (!released.accepted) throw new Error(released.code);
  }
  socket.close();
}
