import { createServer } from 'node:http';

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
    const internal = getAgentState();
    const statuses = new Set([
      'ok', 'disabled', 'gated', 'busy', 'timeout', 'circuit_open',
      'provider_error', 'invalid_output', 'stale_discarded', 'missing', 'already_consumed',
    ]);
    const stableReasons = new Set([
      'admitted', 'telemetry_unknown', 'worker_not_ready', 'worker_recovering',
      'pcm_headroom_low', 'audio_queue_depth_high', 'render_p95_high',
      'render_p99_high', 'recent_underrun', 'unified_memory_low',
      'disabled', 'closed', 'busy', 'circuit_open', 'initialization_pending',
      'deepseek_capability_unavailable', 'result_missing', 'current_domain_rejected',
      'already_consumed', 'stale_discarded', 'not_scheduled',
    ]);
    const safeReason = (value) => {
      if (value === null) return null;
      if (stableReasons.has(value)) return value;
      if (typeof value === 'string'
        && /^(?:HTTP_[1-5][0-9]{2}|[A-Z][A-Z0-9_]{1,63})$/.test(value)) return value;
      return 'status_unavailable';
    };
    const channel = (value = {}) => ({
      enabled: value.enabled === true,
      status: statuses.has(value.status) ? value.status : 'disabled',
      source: value.source === 'llm' ? 'llm' : 'policy',
      reason: safeReason(value.reason),
      circuitState: ['closed', 'open', 'half_open'].includes(value.circuitState)
        ? value.circuitState : 'closed',
    });
    return { species: channel(internal?.species), master: channel(internal?.master) };
  } catch {
    return {
      species: { enabled: false, status: 'disabled', source: 'policy', reason: 'status_unavailable', circuitState: 'closed' },
      master: { enabled: false, status: 'disabled', source: 'policy', reason: 'status_unavailable', circuitState: 'closed' },
    };
  }
}

export function createCandidateServer({
  releaseInfo, apiHandler, upgradeHandler, getAgentState,
}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, {
        ...releaseInfo,
        workerReady: false,
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/readyz') {
      sendJson(response, 503, {
        ...releaseInfo,
        workerReady: false,
        phaseGate: 'shadow-no-audio',
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (apiHandler && apiHandler(request, response) !== false) {
      return;
    }

    sendJson(response, 404, { error: 'NOT_FOUND' });
  });

  if (upgradeHandler) server.on('upgrade', upgradeHandler);
  return server;
}
