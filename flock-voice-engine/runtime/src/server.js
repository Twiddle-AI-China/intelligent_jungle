import { createServer } from 'node:http';

import { projectAgentStatus } from './agents/status-projector.js';

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function safeAgentProviders(getAgentState) {
  if (typeof getAgentState !== 'function') return undefined;
  try {
    const projected = projectAgentStatus(getAgentState());
    return { species: projected.species, master: projected.master };
  } catch {
    const projected = projectAgentStatus(null);
    return { species: projected.species, master: projected.master };
  }
}

function safeWorkerTelemetry(worker) {
  const telemetry = worker?.telemetry;
  if (!telemetry) return undefined;
  const fields = ['renderP95Ms', 'renderP99Ms', 'blockDurationMs', 'recentUnderruns',
    'pcmHeadroomBlocks', 'queueDepth', 'unifiedMemoryFreeBytes', 'appliedCommandSeq'];
  const projected = Object.fromEntries(fields.map((name) => [name, telemetry[name]]));
  const peaks = telemetry.rowMasterContributionPeakAbs;
  return Object.values(projected).every((value) => typeof value === 'number'
    && Number.isFinite(value) && value >= 0) && Array.isArray(peaks)
    && peaks.length > 0 && peaks.length <= 64 && peaks.every((value) => typeof value === 'number'
      && Number.isFinite(value) && value >= 0)
    ? { ...projected, rowMasterContributionPeakAbs: [...peaks] } : undefined;
}

function safeCommandAudit(worker) {
  const batches = worker?.commandAudit;
  if (!Array.isArray(batches) || batches.length > 32) return undefined;
  try {
    const projected = batches.map((batch) => {
      if (!Number.isSafeInteger(batch?.commandSeq) || batch.commandSeq < 1
          || !Array.isArray(batch.commands) || batch.commands.length < 1) throw new Error();
      return { commandSeq: batch.commandSeq, commands: batch.commands.map((command) => {
        if (!command || typeof command.type !== 'string') throw new Error();
        const value = { type: command.type };
        if (Number.isInteger(command.row) && command.row >= 0) value.row = command.row;
        if (typeof command.voice === 'string') value.voice = command.voice;
        return value;
      }) };
    });
    return projected;
  } catch { return undefined; }
}

export function createCandidateServer({
  releaseInfo, apiHandler, latentRoutes, upgradeHandler, audioUpgradeHandler = null,
  getAgentState, audioStatusStore = null,
  getAudioSupervisorStatus = null,
  phaseGate = audioStatusStore ? 'phase5-local' : 'shadow-no-audio',
  legacyRoutes = null,
  staticUi = null,
}) {
  const server = createServer((request, response) => {
    if (staticUi?.handleHttp?.(request, response) === true) return;
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method === 'GET' && pathname === '/healthz') {
      const audioStatus = audioStatusStore?.get?.();
      const worker = getAudioSupervisorStatus?.();
      sendJson(response, 200, {
        ...releaseInfo,
        workerReady: audioStatus?.workerReady === true,
        ...(worker ? { expectedWorkerIdentity: worker.expectedIdentity ?? null,
          reportedWorkerIdentity: worker.reportedIdentity ?? null,
          workerMismatchReason: worker.mismatchReason ?? null,
          ...(safeWorkerTelemetry(worker) ? { workerTelemetry: safeWorkerTelemetry(worker) } : {}) } : {}),
        ...(audioStatus ? { audioStatus } : {}),
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/readyz') {
      const audioStatus = audioStatusStore?.get?.();
      const worker = getAudioSupervisorStatus?.();
      const ready = audioStatus?.workerReady === true && audioStatus?.recovering === false
        && audioStatus?.degraded === false;
      sendJson(response, ready ? 200 : 503, {
        ...releaseInfo,
        workerReady: ready,
        phaseGate,
        runtimeOwner: audioStatus?.runtimeOwner ?? releaseInfo?.runtimeOwner,
        audioOwner: audioStatus?.audioOwner ?? releaseInfo?.audioOwner,
        workerIdentity: {
          expected: worker?.expectedIdentity ?? null,
          reported: worker?.reportedIdentity ?? null,
        },
        ...(safeCommandAudit(worker) ? { audioCommandAudit: safeCommandAudit(worker) } : {}),
        ...(safeWorkerTelemetry(worker) ? { workerTelemetry: safeWorkerTelemetry(worker) } : {}),
        ...(audioStatus ? { audioStatus } : {}),
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (pathname.startsWith('/api/v1/latent-maps/')) {
      if (latentRoutes) latentRoutes(request, response);
      else sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }

    if (legacyRoutes?.handleHttp?.(request, response) === true) return;

    if (apiHandler && apiHandler(request, response) !== false) {
      return;
    }

    sendJson(response, 404, { error: 'NOT_FOUND' });
  });

  if (upgradeHandler || audioUpgradeHandler || legacyRoutes) server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/v1/audio' && audioUpgradeHandler) {
      audioUpgradeHandler(request, socket, head);
    } else if (pathname === '/decoder' && legacyRoutes?.handleUpgrade(request, socket, head)) {
      // handled by compatibility gateway
    } else if (upgradeHandler) upgradeHandler(request, socket, head);
    else socket.destroy?.();
  });
  return server;
}
