#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import WebSocket from 'ws';

import { readCandidateOps } from './lib/candidate-ops.mjs';
import {
  canonicalJson,
  validateLeaseEvidence,
} from './lib/phase5-lease-evidence.mjs';

const CANDIDATE_BROWSER_ORIGIN = 'http://127.0.0.1:18090';
const CLEANUP_MARKER = '.soak-cleanup-owner.json';
const STAGING_CLEANUP_MARKER = '.soak-staging-owner.json';
const CLEANUP_TOKEN = randomUUID();
export const FIXED = Object.freeze({ clients: 4, slowClient: 4, durationMinutes: 30,
  surfaceProfile: 'production-fixed-entry', speciesBaseUrl: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent' });

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
  if (options.baseUrl !== CANDIDATE_BROWSER_ORIGIN) {
    throw new Error('LOOPBACK_CANDIDATE_URL_REQUIRED');
  }
  for (const [name, expected] of Object.entries(FIXED)) {
    if (options[name] !== expected) throw new Error('EQUIVALENT_STAGING_PROFILE_REQUIRED');
  }
  if (basename(options.output) !== 'acceptance.json') throw new Error('ACCEPTANCE_OUTPUT_REQUIRED');
  return true;
}
function exactObjectKeys(value, names) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
}

function plainJsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateSoakLocalPaths(options) {
  let output;
  let stagingAttestation;
  let listeningChecklist;
  try {
    output = resolve(options.output);
    stagingAttestation = resolve(options.stagingAttestation);
    listeningChecklist = resolve(options.listeningChecklist);
  } catch {
    throw new Error('LOCAL_RAW_EVIDENCE_PATH_REQUIRED');
  }
  const root = dirname(output);
  if (stagingAttestation !== join(root, 'staging-machine-attestation.json')) {
    throw new Error('STAGING_ATTESTATION_OUTPUT_REQUIRED');
  }
  if (listeningChecklist !== join(root, 'listening-checklist.json')) {
    throw new Error('LOCAL_RAW_EVIDENCE_PATH_REQUIRED');
  }
  return Object.freeze({
    output,
    root,
    stagingAttestation,
    stagingEvidence: `${stagingAttestation}.evidence`,
    listeningChecklist,
    evidenceRoot: join(root, 'acceptance-evidence'),
    temporaryEvidence: join(root, `.acceptance-evidence-${process.pid}`),
  });
}

function cleanupMarkerBytes(output) {
  return canonicalJson({
    schemaVersion: 1,
    processId: process.pid,
    output: basename(output),
    cleanupToken: CLEANUP_TOKEN,
  });
}

function stagingCleanupMarkerBytes(stagingAttestation) {
  return canonicalJson({
    schemaVersion: 1,
    processId: process.pid,
    stagingAttestation: basename(stagingAttestation),
    cleanupToken: CLEANUP_TOKEN,
  });
}

export function buildSoakRequestPlan(options) {
  validateFixedOptions(options);
  return Object.freeze({
    browserOrigin: CANDIDATE_BROWSER_ORIGIN,
    bootstrapUrl: `${CANDIDATE_BROWSER_ORIGIN}/api/v1/bootstrap`,
    runtimeUrl: 'ws://127.0.0.1:18090/api/v1/runtime',
    audioUrl: 'ws://127.0.0.1:18090/api/v1/audio',
    opsPath: '/readyz',
    opsReader: 'docker-exec:flock-runtime-candidate',
    browserHttpHeaders: Object.freeze({ origin: CANDIDATE_BROWSER_ORIGIN }),
    browserWebSocketOptions: Object.freeze({ origin: CANDIDATE_BROWSER_ORIGIN }),
  });
}

export function settleSnapshotProbeFrame(state, frame, metrics, nowMs = performance.now()) {
  if (frame?.type === 'command.result'
      && typeof frame.commandId === 'string'
      && state.pending.has(frame.commandId)) {
    state.pending.delete(frame.commandId);
    metrics.uiProbeFailures += 1;
    return false;
  }
  if (frame?.type !== 'snapshot' || state.pending.size === 0) return false;
  const commandId = state.pending.keys().next().value;
  const sentAt = state.pending.get(commandId);
  state.pending.delete(commandId);
  const measurementEnd = metrics.measurementEnded || metrics.measurementDeadline;
  if (Number.isFinite(measurementEnd) && measurementEnd > 0 && nowMs > measurementEnd) {
    metrics.uiProbeFailures += 1;
    return false;
  }
  metrics.uiStateLagSamples.push({
    atMs: nowMs - metrics.measurementStarted,
    latencyMs: nowMs - sentAt,
  });
  return true;
}

export function validateChromiumEvidence(value, expectedIdentity = null) {
  try {
    const projects = value?.config?.projects;
    const suites = value?.suites;
    const metadata = value?.config?.metadata;
    const configFile = value?.config?.configFile;
    const spec = Array.isArray(suites)
      ? suites.find((item) => item?.file === 'phase5-local.spec.js')
      : null;
    const testResult = spec?.specs?.[0]?.tests?.[0];
    const attachments = testResult?.results?.[0]?.attachments;
    const attachment = attachments?.find((item) => (
      item?.name === 'phase5-runtime-identity'
        && item?.contentType === 'application/json'
    ));
    const leaseAttachment = attachments?.find((item) => item?.name === 'phase5-lease-evidence'
      && item?.contentType === 'application/json');
    const decodeAttachment = ({ body }) => {
      if (typeof body !== 'string') throw new Error('ATTACHMENT_BODY_REQUIRED');
      const bytes = Buffer.from(body, 'base64');
      if (bytes.toString('base64') !== body) throw new Error('ATTACHMENT_BASE64_INVALID');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = JSON.parse(text);
      if (!Buffer.from(canonicalJson(parsed)).equals(bytes)) {
        throw new Error('ATTACHMENT_JSON_NON_CANONICAL');
      }
      return parsed;
    };
    const ready = decodeAttachment(attachment);
    const lease = validateLeaseEvidence(decodeAttachment(leaseAttachment));
    const readyValue = ready?.value;
    const readyIdentity = readyValue?.workerIdentity;
    if (!Array.isArray(projects) || projects.length !== 1 || projects[0]?.name !== 'chromium'
        || basename(configFile ?? '') !== 'playwright.phase5-acceptance.config.js'
        || metadata?.phase5Mode !== true || metadata?.phase5Acceptance !== true
        || metadata?.surfaceProfile !== 'production-fixed-entry'
        || !spec || spec.specs?.length !== 1 || spec.specs[0]?.ok !== true
        || testResult?.projectName !== 'chromium' || testResult?.status !== 'expected'
        || testResult?.results?.length !== 1 || testResult.results[0]?.status !== 'passed'
        || attachments?.length !== 2
        || !exactObjectKeys(ready, ['status', 'value'])
        || !exactObjectKeys(readyValue, [
          'audioOwner', 'phaseGate', 'runtimeOwner', 'workerIdentity', 'workerReady',
        ])
        || !exactObjectKeys(readyIdentity, ['expected', 'reported'])
        || ready?.status !== 200 || readyValue?.workerReady !== true
        || readyValue?.runtimeOwner !== 'server' || readyValue?.audioOwner !== 'world'
        || !['phase5-local', 'phase5-production'].includes(readyValue?.phaseGate)
        || (expectedIdentity
          && (canonicalJson(readyIdentity?.expected) !== canonicalJson(expectedIdentity)
            || canonicalJson(readyIdentity?.reported) !== canonicalJson(expectedIdentity)))
        || value?.stats?.unexpected !== 0 || value?.stats?.expected !== 1
        || value?.stats?.skipped !== 0 || value?.stats?.flaky !== 0) {
      throw new Error('PHASE5_PRODUCTION_E2E_REQUIRED');
    }
    return lease;
  } catch (error) {
    if (error?.message === 'PHASE5_PRODUCTION_E2E_REQUIRED') throw error;
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

export function requireSlowClientTransport(audioSocket) {
  const transport = audioSocket?._socket;
  if (typeof transport?.pause !== 'function' || typeof transport?.resume !== 'function'
      || typeof transport?.isPaused !== 'function') {
    throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
  }
  const isPaused = () => {
    const value = transport.isPaused();
    if (typeof value !== 'boolean') throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
    return value;
  };
  return Object.freeze({
    isPaused,
    pause() {
      if (isPaused()) throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
      transport.pause();
      if (!isPaused()) throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
      return true;
    },
    resume() {
      if (!isPaused()) return false;
      transport.resume();
      if (isPaused()) throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
      return true;
    },
  });
}

export function advanceSlowClientSchedule(schedule, controller, nowMs) {
  if (!schedule || !Number.isFinite(schedule.nextPauseAtMs)
      || (schedule.resumeAtMs !== null && !Number.isFinite(schedule.resumeAtMs))
      || !Number.isFinite(nowMs) || typeof controller?.isPaused !== 'function'
      || typeof controller?.pause !== 'function' || typeof controller?.resume !== 'function') {
    throw new Error('SLOW_CLIENT_SCHEDULE_INVALID');
  }
  if (schedule.resumeAtMs !== null && nowMs >= schedule.resumeAtMs) {
    if (!controller.isPaused()) throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
    controller.resume();
    schedule.resumeAtMs = null;
  }
  if (schedule.resumeAtMs === null && nowMs >= schedule.nextPauseAtMs) {
    if (controller.isPaused()) throw new Error('SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE');
    controller.pause();
    schedule.resumeAtMs = nowMs + 2000;
    schedule.nextPauseAtMs += 5000;
  }
  return schedule;
}

export function nextAbsoluteCadenceAt(scheduledAtMs, observedAfterWorkMs, cadenceMs) {
  if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(observedAfterWorkMs)
      || !Number.isFinite(cadenceMs) || cadenceMs <= 0
      || observedAfterWorkMs < scheduledAtMs) {
    throw new Error('SOAK_CADENCE_INVALID');
  }
  const firstNext = scheduledAtMs + cadenceMs;
  if (firstNext > observedAfterWorkMs) return firstNext;
  return firstNext
    + (Math.floor((observedAfterWorkMs - firstNext) / cadenceMs) + 1) * cadenceMs;
}

export function closeSoakMeasurementClients(clients, metrics, slowClientTransport) {
  const errors = [];
  metrics.stopping = true;
  try {
    if (slowClientTransport.isPaused()) slowClientTransport.resume();
  } catch (error) {
    errors.push(error);
  }
  for (const socket of clients.flatMap((item) => [item.runtime, item.audio])) {
    try {
      socket.close(1000);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'SOAK_CLIENT_CLEANUP_FAILED');
  }
  return true;
}

async function openClient(plan, number, metrics) {
  const started = performance.now();
  const response = await fetch(plan.bootstrapUrl, {
    headers: plan.browserHttpHeaders, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('SOAK_BOOTSTRAP_FAILED');
  const bootstrap = await response.json();
  metrics.bootstrapSamples.push(performance.now() - started);
  const runtime = await websocket(plan.runtimeUrl, plan.browserWebSocketOptions);
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
      if (Number.isSafeInteger(frame.resultRevision)) {
        state.revision = Math.max(state.revision, frame.resultRevision);
      }
      settleSnapshotProbeFrame(state, frame, metrics);
      if (frame.type === 'ready') {
        clearTimeout(timer); metrics.runtimeReadySamples.push(performance.now() - runtimeStarted);
        resolveReady();
      }
    });
  });
  const audio = await websocket(plan.audioUrl, plan.browserWebSocketOptions);
  let cursor = null;
  audio.on('message', (data, binary) => {
    try {
      const observedAt = performance.now();
      const measurementEnd = metrics.measurementEnded || metrics.measurementDeadline;
      if (Number.isFinite(measurementEnd) && measurementEnd > 0
          && observedAt > measurementEnd) return;
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
          observedAt - metrics.lastPcmAt[number - 1]);
      }
      metrics.lastPcmAt[number - 1] = observedAt;
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

export async function speciesRequest(url, model, mode, metrics, injectedOps = {}) {
  const fetchImpl = injectedOps.fetchImpl ?? fetch;
  const nowImpl = injectedOps.nowImpl ?? (() => performance.now());
  const started = nowImpl();
  try {
    const response = await fetchImpl(`${url}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model, temperature: 0, max_tokens: 16,
        response_format: { type: 'json_schema', json_schema: {
          name: 'flock_health_token', strict: true,
          schema: { type: 'object', additionalProperties: false, required: ['ok'],
            properties: { ok: { const: true } } },
        } },
        messages: [{ role: 'user', content: 'Return one compact JSON health token.' }] }) });
    if (response?.ok !== true || response?.status !== 200) {
      throw new Error(`HTTP_${response?.status}`);
    }
    const envelope = await response.json();
    if (!plainJsonObject(envelope)
        || !Object.hasOwn(envelope, 'choices')
        || !Array.isArray(envelope.choices) || envelope.choices.length === 0
        || !plainJsonObject(envelope.choices[0])
        || !Object.hasOwn(envelope.choices[0], 'message')
        || !plainJsonObject(envelope.choices[0].message)
        || !Object.hasOwn(envelope.choices[0].message, 'content')) {
      throw new Error('SPECIES_RESPONSE_INVALID');
    }
    const content = envelope.choices[0].message.content;
    if (typeof content !== 'string'
        || !/^[\x20\t\r\n]*\{[\x20\t\r\n]*"ok"[\x20\t\r\n]*:[\x20\t\r\n]*true[\x20\t\r\n]*\}[\x20\t\r\n]*$/.test(content)) {
      throw new Error('SPECIES_RESPONSE_INVALID');
    }
    const token = JSON.parse(content);
    if (!plainJsonObject(token)
        || !Object.hasOwn(token, 'ok')
        || Object.keys(token).length !== 1 || token.ok !== true) {
      throw new Error('SPECIES_RESPONSE_INVALID');
    }
    metrics.species[mode].push({ atMs: started - metrics.measurementStarted,
      ok: true, latencyMs: nowImpl() - started });
  } catch {
    metrics.speciesErrors += 1;
    metrics.species[mode].push({ atMs: started - metrics.measurementStarted,
      ok: false, latencyMs: nowImpl() - started });
  }
}

function trackSpeciesRequest(promise, metrics) {
  metrics.inFlightSpecies.add(promise);
  promise.finally(() => metrics.inFlightSpecies.delete(promise));
  return promise;
}

function loadOpsJson(plan) {
  return readCandidateOps(plan.opsPath).then(({ statusCode, body }) => ({
    ok: statusCode >= 200 && statusCode < 300,
    value: body,
  }));
}

async function pollTelemetry(plan, metrics) {
  try {
    const response = await loadOpsJson(plan);
    const { value } = response;
    if (!response.ok || value.workerReady !== true) throw new Error('WORKER_NOT_READY');
    const telemetry = value.workerTelemetry;
    if (Number.isFinite(telemetry?.renderP95Ms) && Number.isFinite(telemetry?.renderP99Ms)
        && Number.isFinite(telemetry?.blockDurationMs) && telemetry.blockDurationMs > 0) {
      const observedAt = performance.now();
      const measurementEnd = metrics.measurementEnded || metrics.measurementDeadline;
      if (Number.isFinite(measurementEnd) && measurementEnd > 0
          && observedAt > measurementEnd) return;
      const atMs = observedAt - metrics.measurementStarted;
      metrics.renderP95Samples.push({ atMs,
        value: telemetry.renderP95Ms / telemetry.blockDurationMs });
      metrics.renderP99Samples.push({ atMs,
        value: telemetry.renderP99Ms / telemetry.blockDurationMs });
      metrics.hotClientUnderruns += Number(telemetry.recentUnderruns ?? 0);
      if (metrics.lastTelemetryAt > 0) metrics.maxTelemetryGapMs = Math.max(
        metrics.maxTelemetryGapMs, observedAt - metrics.lastTelemetryAt);
      metrics.lastTelemetryAt = observedAt;
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

export async function publishAcceptanceArtifacts(paths, acceptance, injectedOps = {}) {
  const renameImpl = injectedOps.renameImpl ?? rename;
  const writeFileImpl = injectedOps.writeFileImpl ?? writeFile;
  const rmImpl = injectedOps.rmImpl ?? rm;
  let ownsPublishedEvidence = false;
  let ownsPublishedOutput = false;
  try {
    await rmImpl(join(paths.temporaryEvidence, CLEANUP_MARKER));
    await rmImpl(join(paths.temporaryEvidence, STAGING_CLEANUP_MARKER));
    await renameImpl(paths.temporaryEvidence, paths.evidenceRoot);
    ownsPublishedEvidence = true;
    await writeFileImpl(paths.output, canonicalJson(acceptance), { flag: 'wx' });
    ownsPublishedOutput = true;
  } catch (error) {
    const cleanupErrors = [];
    const cleanup = async (path, options) => {
      try {
        await rmImpl(path, options);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    };
    await cleanup(paths.temporaryEvidence, { recursive: true, force: true });
    if (ownsPublishedEvidence) {
      await cleanup(paths.evidenceRoot, { recursive: true, force: true });
    }
    await cleanup(paths.stagingAttestation, { force: true });
    await cleanup(paths.stagingEvidence, { recursive: true, force: true });
    if (ownsPublishedOutput) await cleanup(paths.output, { force: true });
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], error.message, { cause: error });
    }
    throw error;
  }
}

async function run(options) {
  validateFixedOptions(options);
  const paths = validateSoakLocalPaths(options);
  const requestPlan = buildSoakRequestPlan(options);
  const {
    output,
    root,
    evidenceRoot,
    temporaryEvidence,
    stagingAttestation,
    stagingEvidence,
    listeningChecklist,
  } = paths;
  for (const path of [
    output,
    evidenceRoot,
    temporaryEvidence,
    stagingAttestation,
    stagingEvidence,
  ]) {
    try { await access(path); throw new Error('ACCEPTANCE_OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(temporaryEvidence, { recursive: false, mode: 0o700 });
  await writeFile(
    join(temporaryEvidence, CLEANUP_MARKER),
    cleanupMarkerBytes(output),
    { flag: 'wx', mode: 0o600 },
  );
  const releasePath = options.release ?? join(root, 'release-manifest.json');
  const releaseRaw = await readFile(releasePath); const release = JSON.parse(releaseRaw);
  if (canonicalJson(release) !== releaseRaw.toString()) throw new Error('RELEASE_MANIFEST_INVALID');
  if (release.workerIdentity?.releaseRevision !== options.releaseRevision) {
    throw new Error('RELEASE_TUPLE_MISMATCH');
  }
  const captureToolSha = await shaFile(CAPTURE_TOOL);
  await assertCleanAttestedTool(options.releaseRevision, captureToolSha);
  const e2ePath = join(temporaryEvidence, 'phase5-e2e.json');
  const e2e = await runChromiumAcceptance(e2ePath,
    join(dirname(releasePath), 'run-flock-audio', 'maintenance-token'));
  const lease = validateChromiumEvidence(e2e, release.workerIdentity);
  const checklist = JSON.parse(await readFile(listeningChecklist, 'utf8'));
  if (checklist.operator !== options.operator || checklist.completed !== true
      || checklist.noClicks !== true || checklist.noStalls !== true
      || checklist.allSpeciesAudible !== true) throw new Error('LISTENING_CHECKLIST_REQUIRED');
  const audibleSpecies = Object.fromEntries(
    ['bass', 'pad', 'lead', 'pluck'].map((species) => [species, true]),
  );
  const leaseSha = await writeEvidence(join(temporaryEvidence, 'lease-evidence.json'), lease);
  const metrics = { runtimeReadySamples: [], bootstrapSamples: [], uiStateLagSamples: [], renderP95Samples: [],
    renderP99Samples: [], species: { normal: [], burst: [] }, speciesErrors: 0,
    uiProbeFailures: 0,
    inFlightSpecies: new Set(),
    pcmBlocks: [0, 0, 0, 0], lastPcmAt: [0, 0, 0, 0], pcmCorruptions: 0,
    cursorDiscontinuitiesUnexpected: 0,
    hotClientMaxPcmGapMs: 0,
    hotClientAbnormalCloses: 0, hotClientReconnectStorms: 0, hotClientUnderruns: 0,
    closed: [], stopping: false, measurementStarted: 0, telemetryFailures: 0,
    measurementDeadline: 0, measurementEnded: 0,
    lastTelemetryAt: 0, maxTelemetryGapMs: 0 };
  const clients = await Promise.all([1, 2, 3, 4]
    .map((number) => openClient(requestPlan, number, metrics)));
  const slowClientTransport = requireSlowClientTransport(clients[3].audio);
  const startedAtUnixMs = Date.now();
  const started = performance.now();
  const measuredDurationMs = options.durationMinutes * 60_000;
  const deadline = started + measuredDurationMs;
  metrics.measurementStarted = started;
  metrics.measurementDeadline = deadline;
  metrics.lastTelemetryAt = started;
  metrics.pcmBlocks.fill(0);
  metrics.lastPcmAt.fill(started);
  let nextNormal = started; let nextBurst = started;
  let nextTelemetryAt = started;
  let nextSnapshot = started; let snapshotClient = 0;
  const slowClientSchedule = { nextPauseAtMs: started + 5000, resumeAtMs: null };
  let measurementError = null;
  let cleanupError = null;
  let hotFinalAges = null;
  try {
    while (true) {
      const now = performance.now();
      if (now >= deadline) break;
      if (now < nextTelemetryAt) {
        await sleep(Math.min(nextTelemetryAt, deadline) - now);
        continue;
      }
      if (now >= nextNormal) { trackSpeciesRequest(speciesRequest(options.speciesBaseUrl,
        options.speciesModel, 'normal', metrics), metrics); nextNormal += 2000; }
      if (now >= nextBurst) { Array.from({ length: 4 }, () => trackSpeciesRequest(
        speciesRequest(options.speciesBaseUrl, options.speciesModel, 'burst', metrics), metrics));
        nextBurst += 10_000; }
      if (now >= nextSnapshot) {
        snapshotProbe(clients[snapshotClient], snapshotClient + 1);
        snapshotClient = (snapshotClient + 1) % clients.length; nextSnapshot += 2000;
      }
      advanceSlowClientSchedule(slowClientSchedule, slowClientTransport, now);
      await pollTelemetry(requestPlan, metrics);
      const afterPoll = performance.now();
      nextTelemetryAt = nextAbsoluteCadenceAt(nextTelemetryAt, afterPoll, 250);
      const sleepUntil = Math.min(nextTelemetryAt, deadline);
      if (afterPoll < sleepUntil) await sleep(sleepUntil - afterPoll);
    }
    metrics.measurementEnded = deadline;
    await Promise.all([...metrics.inFlightSpecies]);
    metrics.species.normal.sort((left, right) => left.atMs - right.atMs);
    metrics.species.burst.sort((left, right) => left.atMs - right.atMs);
    const pendingDeadline = performance.now() + 5000;
    while (clients.some((client) => client.state.pending.size > 0)
        && performance.now() < pendingDeadline) await sleep(50);
    hotFinalAges = metrics.lastPcmAt.slice(0, 3).map((value) => deadline - value);
  } catch (error) {
    measurementError = error;
    metrics.measurementEnded = deadline;
  } finally {
    try {
      closeSoakMeasurementClients(clients, metrics, slowClientTransport);
    } catch (error) {
      cleanupError = error;
    }
    await sleep(100);
  }
  if (measurementError && cleanupError) {
    throw new AggregateError([measurementError, cleanupError], measurementError.message,
      { cause: measurementError });
  }
  if (measurementError) throw measurementError;
  if (cleanupError) throw cleanupError;
  const endedAtUnixMs = startedAtUnixMs + measuredDurationMs;
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
      || metrics.uiProbeFailures !== 0
      || clients.some((client) => client.state.pending.size > 0)
      || metrics.telemetryFailures !== 0 || metrics.maxTelemetryGapMs > 1000
      || deadline - metrics.lastTelemetryAt > 1000
      || metrics.cursorDiscontinuitiesUnexpected !== 0
      || metrics.hotClientAbnormalCloses !== 0
      || metrics.hotClientReconnectStorms !== 0
      || metrics.hotClientUnderruns !== 0
      || metrics.pcmCorruptions !== 0
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
  await execFileAsync('python3', [CAPTURE_TOOL, '--output', stagingAttestation,
    '--vllm-normal-profile', join(temporaryEvidence, 'species-normal-samples.json'),
    '--vllm-burst-profile', join(temporaryEvidence, 'species-burst-samples.json')]);
  await writeFile(
    join(temporaryEvidence, STAGING_CLEANUP_MARKER),
    stagingCleanupMarkerBytes(stagingAttestation),
    { flag: 'wx', mode: 0o600 },
  );
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
      listeningChecklistSha256: await shaFile(listeningChecklist),
      productionMachineAttestationSha256: await shaFile(options.productionAttestation),
      stagingMachineAttestationSha256: await shaFile(stagingAttestation) },
    operatorListening: checklist };
  await publishAcceptanceArtifacts(paths, acceptance);
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

export async function cleanupFailedRun(options) {
  let paths;
  try {
    paths = validateSoakLocalPaths(options);
  } catch {
    return false;
  }
  try {
    const marker = await readFile(join(paths.temporaryEvidence, CLEANUP_MARKER), 'utf8');
    if (marker !== cleanupMarkerBytes(paths.output)) return false;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  let ownsStagingAttestation = false;
  try {
    const marker = await readFile(
      join(paths.temporaryEvidence, STAGING_CLEANUP_MARKER),
      'utf8',
    );
    ownsStagingAttestation = marker
      === stagingCleanupMarkerBytes(paths.stagingAttestation);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(paths.temporaryEvidence, { recursive: true, force: true });
  if (ownsStagingAttestation) {
    await rm(paths.stagingAttestation, { force: true });
    await rm(paths.stagingEvidence, { recursive: true, force: true });
  }
  return true;
}

export async function reportFailedRun(options, error, injectedOps = {}) {
  const cleanupImpl = injectedOps.cleanupImpl ?? cleanupFailedRun;
  const writeStderrImpl = injectedOps.writeStderrImpl
    ?? ((message) => process.stderr.write(message));
  const setExitCodeImpl = injectedOps.setExitCodeImpl
    ?? ((value) => { process.exitCode = value; });
  setExitCodeImpl(2);
  writeStderrImpl(`${error.message}\n`);
  try {
    await cleanupImpl(options);
  } catch (cleanupError) {
    writeStderrImpl(`cleanup failed: ${cleanupError.message}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = cli();
  run(options).catch((error) => reportFailedRun(options, error));
}
