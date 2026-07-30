import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { signedFixture } from './phase5-fault-validation-fixture.js';
import { canonicalJson } from '../../tools/lib/phase5-lease-evidence.mjs';
import {
  createPhase5ClientObservationRecorder,
} from '../../tools/lib/phase5-client-observation-recorder.mjs';

function pcmFrame(revision, sequence, startFrame) {
  const frame = Buffer.alloc(32_800);
  frame.write('FLK1', 0, 'ascii');
  frame.writeUInt8(1, 4); frame.writeUInt8(0, 5);
  frame.writeUInt16LE(32, 6);
  frame.writeUInt32LE(revision, 8);
  frame.writeUInt32LE(sequence, 12);
  frame.writeBigUInt64LE(BigInt(startFrame), 16);
  frame.writeUInt32LE(4_096, 24);
  frame.writeUInt16LE(2, 28); frame.writeUInt16LE(1, 30);
  return frame;
}

test('decoded four-client recorder cross-validates in Python', () => {
  const evidence = signedFixture().evidence;
  const binding = Object.fromEntries([
    'runId', 'challenge', 'release', 'geometry', 'profile',
  ].map((name) => [name, structuredClone(evidence[name])]));
  const window = structuredClone(evidence.window);
  const clients = Array.from({ length: 4 }, (_, index) => ({
    client: index + 1,
    clientIdentitySha256: String(index + 1).repeat(64),
  }));
  const recorder = createPhase5ClientObservationRecorder({
    binding, window, clients,
  });
  const runtimeClaims = clients.map((client) => ({ ...client,
    socketKind: 'runtime', generation: 1 }));
  const audioClaims = clients.map((client) => ({ ...client,
    socketKind: 'audio', generation: 1 }));
  const runtimeOpens = [];
  const audioLifecycle = [];
  const epoch = 'phase5-audio-epoch-1';
  const at = (relative) => ({
    atMonotonicMs: window.startedAtMonotonicMs + relative,
    atUnixMs: window.startedAtUnixMs + relative,
  });
  for (let index = 0; index < 4; index += 1) {
    const client = index + 1;
    recorder.runtimeOpen(runtimeClaims[index], at(0), 'bootstrap');
    runtimeOpens.push({
      client, connectionGeneration: 1, ...at(0), mode: 'bootstrap',
      clientIdentitySha256: clients[index].clientIdentitySha256,
    });
    recorder.runtimeFrame(runtimeClaims[index], at(0), Buffer.from(JSON.stringify({
      type: 'snapshot', worldGeneration: 'world-a', revision: 1, eventSeq: 1,
    })));
    recorder.audioOpen(audioClaims[index], at(0));
    audioLifecycle.push({
      client, connectionGeneration: 1, type: 'audio.open', ...at(0), payload: {},
    });
    recorder.audioJsonFrame(audioClaims[index], at(0), Buffer.from(JSON.stringify({
      type: 'audio.ready', audioEpoch: epoch, streamRevision: 1,
      blockSeq: 0, resumeStartFrame: '0',
    })));
  }
  const cursor = [0, 0, 0, 0];
  const block = [0, 0, 0, 0];
  const pause = { connectionGeneration: 1, ...at(900_000),
    transportSequence: 10_001, transportEventSha256: 'b'.repeat(64) };
  const resume = { connectionGeneration: 1, ...at(907_000),
    transportSequence: 10_002, transportEventSha256: 'c'.repeat(64) };
  for (let relative = 1_000; relative <= 1_800_000; relative += 1_000) {
    if (relative === 900_000) {
      recorder.audioPause(audioClaims[3], at(relative));
    }
    if (relative === 907_000) {
      recorder.audioResume(audioClaims[3], at(relative));
    }
    for (let index = 0; index < 4; index += 1) {
      if (index === 3 && relative >= 900_000 && relative < 907_000) continue;
      recorder.audioPcm(audioClaims[index], at(relative),
        pcmFrame(1, block[index], cursor[index]));
      block[index] += 1; cursor[index] += 4_096;
    }
  }
  const signed = {
    schemaVersion: 1,
    kind: 'phase5-client-observations-signed-transport-projection',
    ...binding,
    window,
    runtimeOpens,
    audioLifecycle,
    slowClient: { client: 4, pause, resume },
    discontinuities: [],
  };
  const bytes = recorder.finalize(signed);
  assert.equal(JSON.parse(bytes).events.filter(
    (event) => event.type === 'audio.pcm').length, 7_193);
  const root = mkdtempSync(join(tmpdir(), 'phase5-clients-'));
  try {
    const rawPath = join(root, 'clients.json');
    const signedPath = join(root, 'signed.json');
    writeFileSync(rawPath, bytes);
    writeFileSync(signedPath, canonicalJson(signed));
    const validator = resolve('../tools/validate_phase5_acceptance.py');
    const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("validator",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
raw=open(sys.argv[2],"rb").read(); value=json.loads(raw)
binding={name:value[name] for name in ("runId","challenge","release","geometry","profile")}
signed=json.load(open(sys.argv[3],"r"))
module.validate_phase5_client_observations_bytes(raw,binding,signed)
`;
    const checked = spawnSync('python3', [
      '-c', script, validator, rawPath, signedPath,
    ], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid PCM is recorded before the recorder fails closed', () => {
  const evidence = signedFixture().evidence;
  const binding = Object.fromEntries([
    'runId', 'challenge', 'release', 'geometry', 'profile',
  ].map((name) => [name, structuredClone(evidence[name])]));
  const clients = Array.from({ length: 4 }, (_, index) => ({
    client: index + 1, clientIdentitySha256: String(index + 1).repeat(64),
  }));
  const recorder = createPhase5ClientObservationRecorder({
    binding, window: structuredClone(evidence.window), clients,
  });
  const claim = { ...clients[0], socketKind: 'audio', generation: 1 };
  const clock = { atMonotonicMs: evidence.window.startedAtMonotonicMs,
    atUnixMs: evidence.window.startedAtUnixMs };
  recorder.audioOpen(claim, clock);
  recorder.audioJsonFrame(claim, clock, Buffer.from(JSON.stringify({
    type: 'audio.ready', audioEpoch: 'epoch-a', streamRevision: 1,
    blockSeq: 0, resumeStartFrame: '0',
  })));
  assert.throws(() => recorder.audioPcm(claim, clock, Buffer.alloc(12)),
    /PHASE5_CLIENT_OBSERVATION_RECORDER_INVALID/u);
});
