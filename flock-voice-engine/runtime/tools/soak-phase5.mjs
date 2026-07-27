#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import WebSocket from 'ws';

export const FIXED = Object.freeze({ clients: 4, slowClient: 4, durationMinutes: 30,
  surfaceProfile: 'production-fixed-entry', speciesBaseUrl: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent' });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const shaBytes = (body) => createHash('sha256').update(body).digest('hex');
const shaFile = async (path) => shaBytes(await readFile(path));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const CAPTURE_TOOL = resolve(fileURLToPath(
  new URL('../../tools/capture_machine_attestation.py', import.meta.url)));
const RUNTIME_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function percentile(samples, fraction) {
  assert.ok(Array.isArray(samples) && samples.length > 0 && fraction > 0 && fraction <= 1,
    'PERCENTILE_SAMPLES_REQUIRED');
  const values = [...samples].sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

export function decodePcmFrame(frameValue, cursor = null) {
  const frame = Buffer.from(frameValue);
  if (frame.length < 32 || frame.toString('ascii', 0, 4) !== 'FLK1'
      || frame.readUInt8(4) !== 1 || frame.readUInt8(5) !== 0
      || frame.readUInt16LE(6) !== 32 || frame.readUInt16LE(28) !== 2
      || frame.readUInt16LE(30) !== 1) throw new Error('PCM_FRAME_HEADER_INVALID');
  const next = { revision: frame.readUInt32LE(8), sequence: frame.readUInt32LE(12),
    startFrame: frame.readBigUInt64LE(16), frames: frame.readUInt32LE(24) };
  if (next.frames < 1 || frame.length !== 32 + next.frames * 2 * 4) {
    throw new Error('PCM_FRAME_LENGTH_INVALID');
  }
  for (let offset = 32; offset < frame.length; offset += 4) {
    if (!Number.isFinite(frame.readFloatLE(offset))) throw new Error('PCM_SAMPLE_INVALID');
  }
  if (cursor && (next.revision !== cursor.revision || next.sequence !== cursor.sequence
      || next.startFrame !== cursor.startFrame)) throw new Error('PCM_CURSOR_DISCONTINUITY');
  return { revision: next.revision, sequence: next.sequence + 1,
    startFrame: next.startFrame + BigInt(next.frames) };
}

export function validateFixedOptions(options) {
  if (options.baseUrl !== 'http://127.0.0.1:18090') throw new Error('LOOPBACK_CANDIDATE_URL_REQUIRED');
  for (const [name, expected] of Object.entries(FIXED)) {
    if (options[name] !== expected) throw new Error('EQUIVALENT_STAGING_PROFILE_REQUIRED');
  }
  if (basename(options.output) !== 'acceptance.json') throw new Error('ACCEPTANCE_OUTPUT_REQUIRED');
  return true;
}

export function validateChromiumEvidence(value, expectedIdentity = null) {
  const projects = value?.config?.projects;
  const suites = value?.suites;
  const metadata = value?.config?.metadata;
  const configFile = value?.config?.configFile;
  const spec = Array.isArray(suites) ? suites.find((item) => item?.file === 'phase5-local.spec.js') : null;
  const testResult = spec?.specs?.[0]?.tests?.[0];
  const attachments = testResult?.results?.[0]?.attachments;
  let ready = null;
  let lease = null;
  try {
    const attachment = attachments?.find((item) => item?.name === 'phase5-runtime-identity'
      && item?.contentType === 'application/json');
    ready = JSON.parse(Buffer.from(attachment.body, 'base64').toString());
    const leaseAttachment = attachments?.find((item) => item?.name === 'phase5-lease-evidence'
      && item?.contentType === 'application/json');
    lease = JSON.parse(Buffer.from(leaseAttachment.body, 'base64').toString());
  } catch { /* rejected below */ }
  if (!Array.isArray(projects) || projects.length !== 1 || projects[0]?.name !== 'chromium'
      || basename(configFile ?? '') !== 'playwright.phase5-acceptance.config.js'
      || metadata?.phase5Mode !== true || metadata?.phase5Acceptance !== true
      || metadata?.surfaceProfile !== 'production-fixed-entry'
      || !spec || spec.specs?.length !== 1 || spec.specs[0]?.ok !== true
      || testResult?.projectName !== 'chromium' || testResult?.status !== 'expected'
      || testResult?.results?.length !== 1 || testResult.results[0]?.status !== 'passed'
      || attachments?.length !== 2 || ready?.status !== 200 || ready?.value?.workerReady !== true
      || lease?.kind !== 'production-fixed-entry-chromium-lease-evidence'
      || JSON.stringify(lease?.sequence) !== JSON.stringify(['demo', 'tracks', 'new-ui'])
      || !['demo', 'tracks', 'new-ui'].every((surface) =>
        lease?.surfaceLeases?.[surface]?.takeAccepted === true
        && lease?.surfaceLeases?.[surface]?.releaseAccepted === true)
      || ready?.value?.runtimeOwner !== 'server' || ready?.value?.audioOwner !== 'world'
      || !['phase5-local', 'phase5-production'].includes(ready?.value?.phaseGate)
      || (expectedIdentity && (canonicalJson(ready?.value?.workerIdentity?.expected) !== canonicalJson(expectedIdentity)
        || canonicalJson(ready?.value?.workerIdentity?.reported) !== canonicalJson(expectedIdentity)))
      || value?.stats?.unexpected !== 0 || value?.stats?.expected !== 1
      || value?.stats?.skipped !== 0 || value?.stats?.flaky !== 0) {
    throw new Error('PHASE5_PRODUCTION_E2E_REQUIRED');
  }
}

function websocket(url, options = {}) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => reject(new Error('SOAK_WS_CONNECT_TIMEOUT')), 5000);
    socket.once('open', () => { clearTimeout(timer); resolveSocket(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function openClient(baseUrl, number, metrics) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/v1/bootstrap`, {
    headers: { origin: 'http://127.0.0.1:4193' }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('SOAK_BOOTSTRAP_FAILED');
  const bootstrap = await response.json();
  metrics.bootstrapSamples.push(performance.now() - started);
  const wsBase = baseUrl.replace('http:', 'ws:');
  const runtime = await websocket(`${wsBase}/api/v1/runtime`, { origin: 'http://127.0.0.1:4193' });
  const runtimeStarted = performance.now();
  const state = { worldGeneration: bootstrap.worldGeneration, revision: bootstrap.revision,
    pending: new Map(), probeSequence: 0 };
  runtime.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientId: bootstrap.clientId,
    bootstrapToken: bootstrap.bootstrapToken, worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision, lastEventSeq: bootstrap.eventSeq }));
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('SOAK_RUNTIME_READY_TIMEOUT')), 5000);
    runtime.on('message', (data, binary) => {
      if (binary) return;
      const frame = JSON.parse(data.toString());
      if (Number.isSafeInteger(frame.revision)) state.revision = Math.max(state.revision, frame.revision);
      if (frame.type === 'command.result' && state.pending.has(frame.commandId)) {
        const sentAt = state.pending.get(frame.commandId);
        metrics.uiStateLagSamples.push({ atMs: performance.now() - metrics.measurementStarted,
          latencyMs: performance.now() - sentAt });
        state.pending.delete(frame.commandId);
      }
      if (frame.type === 'ready') {
        clearTimeout(timer); metrics.runtimeReadySamples.push(performance.now() - runtimeStarted);
        resolveReady();
      }
    });
  });
  const audio = await websocket(`${wsBase}/api/v1/audio`, { origin: 'http://127.0.0.1:4193' });
  let cursor = null;
  audio.on('message', (data, binary) => {
    try {
      if (!binary) {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'audio.ready') {
          cursor = { revision: frame.streamRevision, sequence: frame.blockSeq,
            startFrame: BigInt(frame.resumeStartFrame) };
        } else if (frame.type === 'audio.discontinuity') {
          if (number < FIXED.slowClient) metrics.cursorDiscontinuitiesUnexpected += 1;
          cursor = { revision: frame.streamRevision, sequence: frame.blockSeq,
            startFrame: BigInt(frame.resumeStartFrame) };
        }
        return;
      }
      cursor = decodePcmFrame(data, cursor);
      metrics.pcmBlocks[number - 1] += 1;
      if (number < FIXED.slowClient && metrics.lastPcmAt[number - 1] > 0) {
        metrics.hotClientMaxPcmGapMs = Math.max(metrics.hotClientMaxPcmGapMs,
          performance.now() - metrics.lastPcmAt[number - 1]);
      }
      metrics.lastPcmAt[number - 1] = performance.now();
    } catch {
      metrics.pcmCorruptions += 1;
    }
  });
  for (const [name, socket] of [['runtime', runtime], ['audio', audio]]) {
    socket.on('close', (code) => {
      if (!metrics.stopping && number !== FIXED.slowClient) {
        metrics.hotClientAbnormalCloses += Number(code !== 1000);
        metrics.hotClientReconnectStorms += 1;
      }
      metrics.closed.push(`${number}:${name}:${code}`);
    });
  }
  return { runtime, audio, state };
}

function snapshotProbe(client, number) {
  const commandId = `soak-snapshot-${number}-${client.state.probeSequence++}`;
  client.state.pending.set(commandId, performance.now());
  client.runtime.send(JSON.stringify({ type: 'command', protocolVersion: 1, commandId,
    worldGeneration: client.state.worldGeneration, baseRevision: client.state.revision,
    name: 'snapshot.request', payload: {} }));
}

async function speciesRequest(url, model, mode, metrics) {
  const started = performance.now();
  try {
    const response = await fetch(`${url}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model, temperature: 0, max_tokens: 16,
        messages: [{ role: 'user', content: 'Return one compact JSON health token.' }] }) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    await response.arrayBuffer();
    metrics.species[mode].push({ atMs: started - metrics.measurementStarted,
      ok: true, latencyMs: performance.now() - started });
  } catch {
    metrics.speciesErrors += 1;
    metrics.species[mode].push({ atMs: started - metrics.measurementStarted,
      ok: false, latencyMs: performance.now() - started });
  }
}

function trackSpeciesRequest(promise, metrics) {
  metrics.inFlightSpecies.add(promise);
  promise.finally(() => metrics.inFlightSpecies.delete(promise));
  return promise;
}

async function pollTelemetry(baseUrl, metrics) {
  try {
    const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(3000) });
    const value = await response.json();
    if (!response.ok || value.workerReady !== true) throw new Error('WORKER_NOT_READY');
    const telemetry = value.workerTelemetry;
    if (Number.isFinite(telemetry?.renderP95Ms) && Number.isFinite(telemetry?.renderP99Ms)
        && Number.isFinite(telemetry?.blockDurationMs) && telemetry.blockDurationMs > 0) {
      const atMs = performance.now() - metrics.measurementStarted;
      metrics.renderP95Samples.push({ atMs,
        value: telemetry.renderP95Ms / telemetry.blockDurationMs });
      metrics.renderP99Samples.push({ atMs,
        value: telemetry.renderP99Ms / telemetry.blockDurationMs });
      metrics.hotClientUnderruns += Number(telemetry.recentUnderruns ?? 0);
      if (metrics.lastTelemetryAt > 0) metrics.maxTelemetryGapMs = Math.max(
        metrics.maxTelemetryGapMs, performance.now() - metrics.lastTelemetryAt);
      metrics.lastTelemetryAt = performance.now();
      return;
    }
    throw new Error('WORKER_TELEMETRY_INVALID');
  } catch { metrics.telemetryFailures += 1; }
}

async function assertCleanAttestedTool(releaseRevision, expectedToolSha) {
  const [{ stdout: head }, { stdout: dirty }, toolSha] = await Promise.all([
    execFileAsync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']),
    execFileAsync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no']),
    shaFile(CAPTURE_TOOL),
  ]);
  if (head.trim() !== releaseRevision || dirty.trim() || toolSha !== expectedToolSha) {
    throw new Error('ATTESTED_CLEAN_HEAD_REQUIRED');
  }
}

async function runChromiumAcceptance(output, maintenanceTokenPath) {
  const { stdout } = await execFileAsync('npx', ['playwright', 'test',
    'test/e2e/phase5-local.spec.js', '--config', 'playwright.phase5-acceptance.config.js',
    '--reporter=json'], { cwd: RUNTIME_ROOT, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PHASE5_MAINTENANCE_TOKEN_PATH: maintenanceTokenPath } });
  const value = JSON.parse(stdout);
  await writeEvidence(output, value);
  return value;
}

async function writeEvidence(path, value) {
  await writeFile(path, canonicalJson(value), { flag: 'wx' });
  return shaFile(path);
}

async function run(options) {
  validateFixedOptions(options);
  const output = resolve(options.output); const root = dirname(output);
  const evidenceRoot = join(root, 'acceptance-evidence');
  const temporaryEvidence = join(root, `.acceptance-evidence-${process.pid}`);
  for (const path of [output, evidenceRoot, temporaryEvidence]) {
    try { await access(path); throw new Error('ACCEPTANCE_OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(temporaryEvidence, { recursive: false, mode: 0o700 });
  const releasePath = options.release ?? join(root, 'release-manifest.json');
  const releaseRaw = await readFile(releasePath); const release = JSON.parse(releaseRaw);
  if (canonicalJson(release) !== releaseRaw.toString()) throw new Error('RELEASE_MANIFEST_INVALID');
  if (release.workerIdentity?.releaseRevision !== options.releaseRevision) {
    throw new Error('RELEASE_TUPLE_MISMATCH');
  }
  const captureToolSha = await shaFile(CAPTURE_TOOL);
  await assertCleanAttestedTool(options.releaseRevision, captureToolSha);
  if (resolve(options.stagingAttestation) !== join(root, 'staging-machine-attestation.json')) {
    throw new Error('STAGING_ATTESTATION_OUTPUT_REQUIRED');
  }
  const e2ePath = join(temporaryEvidence, 'phase5-e2e.json');
  const e2e = await runChromiumAcceptance(e2ePath,
    join(dirname(releasePath), 'run-flock-audio', 'maintenance-token'));
  validateChromiumEvidence(e2e, release.workerIdentity);
  const checklist = JSON.parse(await readFile(options.listeningChecklist, 'utf8'));
  if (resolve(options.listeningChecklist) !== join(root, 'listening-checklist.json')) {
    throw new Error('LOCAL_RAW_EVIDENCE_PATH_REQUIRED');
  }
  if (checklist.operator !== options.operator || checklist.completed !== true
      || checklist.noClicks !== true || checklist.noStalls !== true
      || checklist.allSpeciesAudible !== true) throw new Error('LISTENING_CHECKLIST_REQUIRED');
  const leaseAttachment = e2e.config.projects && e2e.suites?.[0]?.specs?.[0]?.tests?.[0]
    ?.results?.[0]?.attachments?.find((item) => item.name === 'phase5-lease-evidence');
  let lease;
  try { lease = JSON.parse(Buffer.from(leaseAttachment.body, 'base64').toString()); }
  catch { throw new Error('SEQUENTIAL_LEASE_EVIDENCE_REQUIRED'); }
  if (lease.schemaVersion !== 1 || lease.kind !== 'production-fixed-entry-chromium-lease-evidence'
      || JSON.stringify(lease.sequence) !== JSON.stringify(['demo', 'tracks', 'new-ui'])
      || !['demo', 'tracks', 'new-ui'].every((surface) =>
        lease.surfaceLeases?.[surface]?.takeAccepted === true
        && lease.surfaceLeases?.[surface]?.releaseAccepted === true)
      || !Number.isSafeInteger(lease.surfaceLeases?.['new-ui']?.commandSeq)
      || lease.surfaceLeases['new-ui'].commandSeq < 1
      || !Number.isSafeInteger(lease.surfaceLeases['new-ui'].releaseCommandSeq)
      || lease.surfaceLeases['new-ui'].releaseCommandSeq
        <= lease.surfaceLeases['new-ui'].commandSeq) {
    throw new Error('SEQUENTIAL_LEASE_EVIDENCE_REQUIRED');
  }
  const audibleSpecies = {};
  for (const species of ['bass', 'pad', 'lead', 'pluck']) {
    const probe = lease.audibleSpecies?.[species];
    if (probe?.commandAccepted !== true || probe?.releaseAccepted !== true
        || !Number.isSafeInteger(probe?.pcmBlocks) || probe.pcmBlocks < 1
        || !Number.isSafeInteger(probe?.commandSeq) || probe.commandSeq < 1
        || !Number.isSafeInteger(probe?.releaseCommandSeq)
        || probe.releaseCommandSeq <= probe.commandSeq
        || !Number.isFinite(probe?.peakAbs) || probe.peakAbs <= 1e-7) {
      throw new Error('AUDIBLE_SPECIES_EVIDENCE_REQUIRED');
    }
    audibleSpecies[species] = true;
  }
  const leaseSha = await writeEvidence(join(temporaryEvidence, 'lease-evidence.json'), lease);
  const metrics = { runtimeReadySamples: [], bootstrapSamples: [], uiStateLagSamples: [], renderP95Samples: [],
    renderP99Samples: [], species: { normal: [], burst: [] }, speciesErrors: 0,
    inFlightSpecies: new Set(),
    pcmBlocks: [0, 0, 0, 0], lastPcmAt: [0, 0, 0, 0], pcmCorruptions: 0,
    cursorDiscontinuitiesUnexpected: 0,
    hotClientMaxPcmGapMs: 0,
    hotClientAbnormalCloses: 0, hotClientReconnectStorms: 0, hotClientUnderruns: 0,
    closed: [], stopping: false, measurementStarted: 0, telemetryFailures: 0,
    lastTelemetryAt: 0, maxTelemetryGapMs: 0 };
  const clients = await Promise.all([1, 2, 3, 4].map((number) => openClient(options.baseUrl, number, metrics)));
  const startedAtUnixMs = Date.now();
  const started = performance.now(); const deadline = started + options.durationMinutes * 60_000;
  metrics.measurementStarted = started; metrics.lastTelemetryAt = started;
  for (let index = 0; index < 3; index += 1) {
    if (metrics.lastPcmAt[index] <= 0) metrics.lastPcmAt[index] = started;
  }
  let nextNormal = started; let nextBurst = started; let nextSlow = started + 5000;
  let nextSnapshot = started; let snapshotClient = 0;
  while (performance.now() < deadline) {
    const now = performance.now();
    if (now >= nextNormal) { trackSpeciesRequest(speciesRequest(options.speciesBaseUrl,
      options.speciesModel, 'normal', metrics), metrics); nextNormal += 2000; }
    if (now >= nextBurst) { Array.from({ length: 4 }, () => trackSpeciesRequest(
      speciesRequest(options.speciesBaseUrl, options.speciesModel, 'burst', metrics), metrics));
      nextBurst += 10_000; }
    if (now >= nextSnapshot) {
      snapshotProbe(clients[snapshotClient], snapshotClient + 1);
      snapshotClient = (snapshotClient + 1) % clients.length; nextSnapshot += 2000;
    }
    if (now >= nextSlow) {
      clients[3].audio._socket?.pause(); await sleep(2000); clients[3].audio._socket?.resume();
      nextSlow += 5000;
    }
    await pollTelemetry(options.baseUrl, metrics); await sleep(250);
  }
  await Promise.all([...metrics.inFlightSpecies]);
  const pendingDeadline = performance.now() + 5000;
  while (clients.some((client) => client.state.pending.size > 0)
      && performance.now() < pendingDeadline) await sleep(50);
  metrics.stopping = true; clients.flatMap((item) => [item.runtime, item.audio]).forEach((socket) => socket.close(1000));
  await sleep(100);
  const endedAtUnixMs = Date.now(); const measuredDurationMs = performance.now() - started;
  const hotFinalAges = metrics.lastPcmAt.slice(0, 3).map((value) => performance.now() - value);
  const expectedUi = Math.floor(measuredDurationMs / 2000);
  const expectedTelemetry = Math.floor(measuredDurationMs / 250);
  const expectedNormal = Math.floor(measuredDurationMs / 2000);
  const expectedBurst = Math.floor(measuredDurationMs / 10_000) * 4;
  if (metrics.runtimeReadySamples.length !== 4
      || metrics.uiStateLagSamples.length < Math.floor(expectedUi * 0.95)
      || metrics.renderP95Samples.length < Math.floor(expectedTelemetry * 0.90)
      || metrics.renderP99Samples.length !== metrics.renderP95Samples.length
      || metrics.species.normal.length < Math.floor(expectedNormal * 0.95)
      || metrics.species.burst.length < Math.floor(expectedBurst * 0.95)
      || clients.some((client) => client.state.pending.size > 0)
      || metrics.telemetryFailures !== 0 || metrics.maxTelemetryGapMs > 1000
      || performance.now() - metrics.lastTelemetryAt > 1000
      || metrics.cursorDiscontinuitiesUnexpected !== 0
      || metrics.pcmBlocks.some((count) => count === 0)
      || metrics.hotClientMaxPcmGapMs > 1000 || hotFinalAges.some((value) => value > 1000)) {
    throw new Error('RAW_PERCENTILE_EVIDENCE_REQUIRED');
  }
  const runtimeSha = await writeEvidence(join(temporaryEvidence, 'runtime-ready-samples.json'), metrics.runtimeReadySamples);
  const uiSha = await writeEvidence(join(temporaryEvidence, 'ui-state-lag-samples.json'), metrics.uiStateLagSamples);
  const renderSha = await writeEvidence(join(temporaryEvidence, 'render-samples.json'), {
    p95BlockFractions: metrics.renderP95Samples, p99BlockFractions: metrics.renderP99Samples });
  const normalSha = await writeEvidence(join(temporaryEvidence, 'species-normal-samples.json'), metrics.species.normal);
  const burstSha = await writeEvidence(join(temporaryEvidence, 'species-burst-samples.json'), metrics.species.burst);
  await assertCleanAttestedTool(options.releaseRevision, captureToolSha);
  await execFileAsync('python3', [CAPTURE_TOOL, '--output', options.stagingAttestation,
    '--vllm-normal-profile', join(temporaryEvidence, 'species-normal-samples.json'),
    '--vllm-burst-profile', join(temporaryEvidence, 'species-burst-samples.json')]);
  await assertCleanAttestedTool(options.releaseRevision, captureToolSha);
  const runSha = await writeEvidence(join(temporaryEvidence, 'soak-run.json'), {
    startedAtUnixMs, endedAtUnixMs, measuredDurationMs, pcmBlocks: metrics.pcmBlocks,
    hotClientMaxPcmGapMs: metrics.hotClientMaxPcmGapMs, hotClientFinalPcmAgeMs: hotFinalAges,
    stability: { hotClientAbnormalCloses: metrics.hotClientAbnormalCloses,
      hotClientReconnectStorms: metrics.hotClientReconnectStorms,
      hotClientUnderruns: metrics.hotClientUnderruns, pcmCorruptions: metrics.pcmCorruptions,
      cursorDiscontinuitiesUnexpected: metrics.cursorDiscontinuitiesUnexpected } });
  const productionGraphSha = await shaFile(options.productionGraph);
  const normalLatencies = metrics.species.normal.filter((item) => item.ok).map((item) => item.latencyMs);
  const burstLatencies = metrics.species.burst.filter((item) => item.ok).map((item) => item.latencyMs);
  const acceptance = { schemaVersion: 1, status: 'accepted',
    environment: { kind: 'isolated-equivalent-spark', surfaceProfile: options.surfaceProfile },
    release: { releaseManifestSha256: shaBytes(releaseRaw),
      releaseRevision: release.workerIdentity.releaseRevision,
      sourceManifestSha256: release.workerIdentity.sourceManifestSha256,
      audioArtifactSha256: release.workerIdentity.audioArtifactSha256 },
    geometry: release.geometry, durationMinutes: measuredDurationMs / 60_000,
    clients: 4, slowClients: 1,
    stability: { hotClientAbnormalCloses: metrics.hotClientAbnormalCloses,
      hotClientReconnectStorms: metrics.hotClientReconnectStorms,
      hotClientUnderruns: metrics.hotClientUnderruns, pcmCorruptions: metrics.pcmCorruptions,
      cursorDiscontinuitiesUnexpected: metrics.cursorDiscontinuitiesUnexpected },
    latency: { runtimeReadyP95Ms: percentile(metrics.runtimeReadySamples, .95),
      uiStateLagP95Ms: percentile(metrics.uiStateLagSamples.map((item) => item.latencyMs), .95),
      renderP95BlockFraction: percentile(metrics.renderP95Samples.map((item) => item.value), .95),
      renderP99BlockFraction: percentile(metrics.renderP99Samples.map((item) => item.value), .99) },
    speciesLoad: { endpoint: options.speciesBaseUrl, model: options.speciesModel,
      normalRequests: metrics.species.normal.length, burstRequests: metrics.species.burst.length,
      errors: metrics.speciesErrors, normalLatencySamplesSha256: normalSha,
      burstLatencySamplesSha256: burstSha },
    audibleSpecies, leaseExercise: lease.sequence,
    evidence: { productionGraphSha256: productionGraphSha,
      phase5E2eSha256: await shaFile(e2ePath),
      rawRuntimeReadySamplesSha256: runtimeSha, rawUiStateLagSamplesSha256: uiSha,
      rawRenderSamplesSha256: renderSha,
      soakRunSha256: runSha,
      leaseEvidenceSha256: leaseSha,
      listeningChecklistSha256: await shaFile(options.listeningChecklist),
      productionMachineAttestationSha256: await shaFile(options.productionAttestation),
      stagingMachineAttestationSha256: await shaFile(options.stagingAttestation) },
    operatorListening: checklist };
  try {
    await rename(temporaryEvidence, evidenceRoot);
    await writeFile(output, canonicalJson(acceptance), { flag: 'wx' });
  } catch (error) {
    await rm(temporaryEvidence, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
    await rm(options.stagingAttestation, { force: true });
    await rm(`${options.stagingAttestation}.evidence`, { recursive: true, force: true });
    await rm(output, { force: true });
    throw error;
  }
}

function cli() {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string' }, 'species-base-url': { type: 'string' },
    'species-model': { type: 'string' }, clients: { type: 'string' },
    'slow-client': { type: 'string' }, 'duration-minutes': { type: 'string' },
    'surface-profile': { type: 'string' },
    'production-attestation': { type: 'string' }, 'staging-attestation': { type: 'string' },
    'production-graph': { type: 'string' }, release: { type: 'string' },
    'release-revision': { type: 'string' }, operator: { type: 'string' },
    'listening-checklist': { type: 'string' },
    output: { type: 'string' },
  } });
  const required = ['base-url', 'species-base-url', 'species-model', 'clients', 'slow-client',
    'duration-minutes', 'surface-profile', 'production-attestation',
    'staging-attestation', 'production-graph', 'release-revision', 'operator',
    'listening-checklist', 'output'];
  if (required.some((name) => !values[name])) throw new Error('SOAK_ARGUMENT_REQUIRED');
  return { baseUrl: values['base-url'], speciesBaseUrl: values['species-base-url'],
    speciesModel: values['species-model'], clients: Number(values.clients),
    slowClient: Number(values['slow-client']), durationMinutes: Number(values['duration-minutes']),
    surfaceProfile: values['surface-profile'],
    productionAttestation: resolve(values['production-attestation']),
    stagingAttestation: resolve(values['staging-attestation']),
    productionGraph: resolve(values['production-graph']), release: values.release && resolve(values.release),
    releaseRevision: values['release-revision'], operator: values.operator,
    listeningChecklist: resolve(values['listening-checklist']),
    output: resolve(values.output) };
}

async function cleanupFailedRun(options) {
  const output = resolve(options.output); const root = dirname(output);
  const temporary = join(root, `.acceptance-evidence-${process.pid}`);
  try {
    await access(temporary);
    await rm(temporary, { recursive: true, force: true });
    await rm(options.stagingAttestation, { force: true });
    await rm(`${options.stagingAttestation}.evidence`, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = cli();
  run(options).catch(async (error) => {
    await cleanupFailedRun(options);
    process.stderr.write(`${error.message}\n`); process.exitCode = 2;
  });
}
