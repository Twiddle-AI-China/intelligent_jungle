import { createAgentOrchestrator } from './agent-orchestrator.js';
import { createDeepSeekMasterProvider } from './deepseek-master-provider.js';
import {
  DEFAULT_GPU_THRESHOLDS,
  evaluateSpeciesAdmission,
} from './gpu-admission.js';
import { createProviderRunner } from './provider-runner.js';
import { createSpeciesProvider } from './species-provider.js';
import { fallbackMasterDecision, fallbackSpeciesPlan } from '../domain/deterministic-conductor.js';
import { normalizeMasterDecision } from '../domain/master/policy.js';
import { revalidateSpeciesPlan } from './species-prompt.js';

const RUNNER_CONFIGS = Object.freeze({
  species: Object.freeze({
    attemptTimeoutMs: 12_000,
    deadlineMs: 15_000,
    maxAttempts: 2,
    failureThreshold: 3,
    cooldownMs: 60_000,
  }),
  master: Object.freeze({
    attemptTimeoutMs: 30_000,
    deadlineMs: 45_000,
    maxAttempts: 2,
    failureThreshold: 3,
    cooldownMs: 120_000,
  }),
});
const MASTER_CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const SPECIES_DISABLED_ADMISSION = Object.freeze({
  admitted: false,
  reason: 'disabled',
  sampledAtMs: null,
});

function disabledResult(requestId, reason) {
  return Object.freeze({ accepted: false, reason, requestId });
}

export function createAgentComposition({
  providerConfig,
  fetchImpl = globalThis.fetch,
  clock = { now: () => Date.now() },
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  publishEnvelope,
  runnerFactory = createProviderRunner,
  speciesTelemetry = null,
  getSpeciesTelemetry = null,
  gpuThresholds = DEFAULT_GPU_THRESHOLDS,
  policies = null,
  closeDrainTimeoutMs = 1_000,
} = {}) {
  if (!providerConfig || typeof publishEnvelope !== 'function'
    || typeof runnerFactory !== 'function' || typeof clock?.now !== 'function') {
    throw new TypeError('AGENT_COMPOSITION_INVALID');
  }
  if (providerConfig.masterEnabled === true && !providerConfig.masterApiKey) {
    throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  }

  const speciesProvider = createSpeciesProvider({ fetchImpl });
  const masterProvider = providerConfig.masterEnabled
    ? createDeepSeekMasterProvider({
      fetchImpl,
      baseUrl: providerConfig.masterBaseUrl,
      model: providerConfig.masterModel,
      apiKey: providerConfig.masterApiKey,
    })
    : null;

  const rawRunners = {};
  for (const channel of ['species', 'master']) {
    const config = Object.freeze({
      channel,
      ...RUNNER_CONFIGS[channel],
      clock,
      setTimer,
      clearTimer,
    });
    rawRunners[channel] = runnerFactory(config);
  }
  if (!rawRunners.species || !rawRunners.master
    || rawRunners.species === rawRunners.master) throw new TypeError('AGENT_RUNNERS_NOT_ISOLATED');

  let initialized = false;
  let closed = false;
  let masterReady = false;
  let initializationPromise = null;
  let initializationAbortController = null;
  let initializationDeadline = null;
  let resolveInitializationClosed = null;
  let masterDisabledReason = providerConfig.masterEnabled
    ? 'initialization_pending' : 'disabled';

  const speciesEnabled = providerConfig.speciesEnabled === true;
  const telemetrySource = typeof getSpeciesTelemetry === 'function'
    ? getSpeciesTelemetry : () => speciesTelemetry;

  function wrapRunner(channel, providerRequest) {
    const raw = rawRunners[channel];
    return Object.freeze({
      providerRequest,
      tryStart(job) {
        if (closed) return disabledResult(job?.requestId ?? '', 'closed');
        if (channel === 'species' && !speciesEnabled) {
          return disabledResult(job?.requestId ?? '', 'disabled');
        }
        if (channel === 'master' && !masterReady) {
          return disabledResult(job?.requestId ?? '', masterDisabledReason);
        }
        return raw.tryStart(job);
      },
      getStatus() {
        return raw.getStatus?.() ?? { circuitState: 'closed' };
      },
      close() { return raw.close?.(); },
    });
  }

  const speciesRunner = wrapRunner(
    'species',
    (input, options) => speciesProvider.request(input, options),
  );
  const masterRunner = wrapRunner(
    'master',
    (input, options) => masterProvider?.request(input, options),
  );
  const fallbackPolicies = policies ?? {
    species: fallbackSpeciesPlan,
    master: fallbackMasterDecision,
    validateSpecies: (value, domain) => revalidateSpeciesPlan(value, domain.flockInput),
    validateMaster: (value, domain) => normalizeMasterDecision(
      value,
      domain.masterInput?.menu,
      domain.masterInput?.state,
    ),
  };
  const orchestrator = createAgentOrchestrator({
    speciesRunner,
    masterRunner,
    admission: () => speciesEnabled
      ? evaluateSpeciesAdmission(
        telemetrySource(), gpuThresholds, Number(clock.now()),
      )
      : SPECIES_DISABLED_ADMISSION,
    policies: fallbackPolicies,
    publishEnvelope,
    clock,
  });

  function initialize() {
    if (closed) return Promise.resolve(false);
    if (initializationPromise !== null) {
      return initializationPromise;
    }
    if (initialized) {
      return Promise.resolve(
        masterReady || !providerConfig.masterEnabled,
      );
    }
    initialized = true;
    if (!providerConfig.masterEnabled) {
      initializationPromise = Promise.resolve(true);
      return initializationPromise;
    }
    const controller = new AbortController();
    initializationAbortController = controller;
    const closedOutcome = new Promise((resolve) => {
      resolveInitializationClosed = () => resolve({
        kind: 'closed',
      });
    });
    const deadlineOutcome = new Promise((resolve) => {
      initializationDeadline = setTimer(() => {
        controller.abort();
        resolve({ kind: 'timeout' });
      }, MASTER_CAPABILITY_PROBE_TIMEOUT_MS);
    });
    const probeOutcome = Promise.resolve()
      .then(() => masterProvider.probeCapabilities({
        signal: controller.signal,
      }))
      .then(
        (probe) => ({ kind: 'probe', probe }),
        () => ({ kind: 'failure' }),
      );
    initializationPromise = Promise.race([
      probeOutcome,
      closedOutcome,
      deadlineOutcome,
    ]).then((outcome) => {
      if (closed || outcome.kind !== 'probe') {
        masterReady = false;
        masterDisabledReason =
          'deepseek_capability_unavailable';
        return false;
      }
      if (outcome.probe.ok) {
        masterReady = true;
        masterDisabledReason = null;
        return true;
      }
      masterReady = false;
      masterDisabledReason =
        'deepseek_capability_unavailable';
      return false;
    }).finally(() => {
      const deadline = initializationDeadline;
      initializationDeadline = null;
      initializationAbortController = null;
      resolveInitializationClosed = null;
      if (deadline !== null) {
        try {
          clearTimer(deadline);
        } catch {
          // Initialization already has an authoritative outcome.
        }
      }
    });
    return initializationPromise;
  }

  async function close() {
    if (closed) return false;
    closed = true;
    initializationAbortController?.abort();
    resolveInitializationClosed?.();
    const closing = orchestrator.close();
    const drains = Array.isArray(closing) ? closing : [];
    if (drains.length && Number.isFinite(closeDrainTimeoutMs) && closeDrainTimeoutMs >= 0) {
      let timer = null;
      await Promise.race([
        Promise.allSettled(drains),
        new Promise((resolve) => {
          timer = setTimer(resolve, closeDrainTimeoutMs);
        }),
      ]);
      if (timer !== null) clearTimer(timer);
    }
    return true;
  }

  return Object.freeze({
    initialize,
    scheduleReview: orchestrator.scheduleReview,
    acceptEnvelope: orchestrator.acceptEnvelope,
    takeForBoundary: orchestrator.takeForBoundary,
    resetGeneration: orchestrator.resetGeneration,
    getPublicState: orchestrator.getPublicState,
    close,
  });
}
