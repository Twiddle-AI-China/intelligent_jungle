import {
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import {
  createServer,
} from 'node:net';
import {
  clearTimeout,
  setTimeout,
} from 'node:timers';
import {
  once,
} from 'node:events';

import {
  _startPhase5CaptureChannelServer,
} from '../../tools/lib/phase5-capture-channel-server.mjs';
import {
  createPhase5CaptureChannelProtocol,
} from '../../tools/lib/phase5-capture-channel-protocol.mjs';
import {
  createPhase5CandidateCaptureFinalizer,
} from '../../tools/lib/phase5-capture-finalizer.mjs';
import {
  createCompletedPhase5FaultSessionAuthority,
} from '../helpers/phase5-fault-session-authority.js';
import {
  canonicalJson,
} from '../../tools/lib/phase5-fault-evidence.mjs';

const identity = {
  runId: '123e4567-e89b-42d3-a456-426614174000',
  challenge: '1'.repeat(64),
  release: {
    releaseManifestSha256: '2'.repeat(64),
    releaseRevision: '3'.repeat(40),
    sourceManifestSha256: '4'.repeat(64),
    audioArtifactSha256: '5'.repeat(64),
  },
  geometry: {
    sampleRate: 44_100,
    blockFrames: 4_096,
    poolSize: 5,
    rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'],
  },
  profile: {
    clients: 4,
    slowClient: 4,
    durationMinutes: 30,
    speciesEndpoint: 'http://127.0.0.1:8081/v1',
    speciesModel: 'bird_agent',
  },
};

async function main() {
  if (process.argv.length !== 3) {
    throw new Error('LINUX_PROBE_SOCKET_PATH_REQUIRED');
  }
  const socketPath = process.argv[2];
  const finalizer = createPhase5CandidateCaptureFinalizer({
    faultSessionAuthority: createCompletedPhase5FaultSessionAuthority({
      identity,
      captureNonceBytes: randomBytes(32),
    }),
  });
  const protocol = createPhase5CaptureChannelProtocol({
    finalizer,
  });
  let resolveSocketReadEnded;
  const socketReadEnded = new Promise((resolve) => {
    resolveSocketReadEnded = resolve;
  });
  let receivedSocketBytes = 0;
  const service = await _startPhase5CaptureChannelServer({
    protocol,
    socketPath,
    platform: process.platform,
    getuid: () => process.getuid(),
    createServer: (handler) => createServer(
      { allowHalfOpen: true },
      (peer) => {
        let socketReadSettled = false;
        const settleSocketRead = () => {
          if (socketReadSettled) return;
          socketReadSettled = true;
          resolveSocketReadEnded();
        };
        peer.on('data', (chunk) => {
          receivedSocketBytes += chunk.byteLength;
        });
        peer.once('end', settleSocketRead);
        peer.once('close', settleSocketRead);
        handler(peer);
      },
    ),
    lstatSync,
    unlinkSync,
    chmodSync,
    scheduleTimeout: (handler, milliseconds) => setTimeout(
      handler,
      milliseconds,
    ),
    cancelTimeout: (token) => clearTimeout(token),
  });

  process.stdout.write(service.getAdmissionBytes());
  process.stdin.resume();
  const closeSignal = once(process.stdin, 'data');
  await socketReadEnded;
  await closeSignal;
  await service.close();

  let sealed = false;
  try {
    protocol.handleFinalizeRequestBytes(Buffer.alloc(0));
  } catch (error) {
    sealed = error?.code === 'PHASE5_CAPTURE_CHANNEL_ALREADY_USED';
  }
  process.stdout.write(`${canonicalJson({
    closed: true,
    receivedSocketBytes,
    sealed,
  })}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error
    ? error.message.split(/\r?\n/u, 1)[0]
    : 'PHASE5_CAPTURE_CHANNEL_LINUX_PROBE_FAILED';
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
