#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createPhase5ClientObservationRecorder }
  from './lib/phase5-client-observation-recorder.mjs';
import {
  createPhase5ControllerFdTransport,
  createPhase5ControllerSessionClient,
} from './lib/phase5-controller-session-client.mjs';
import { createPhase5LatencyRecorder }
  from './lib/phase5-latency-recorder.mjs';
import {
  buildPhase5SoakRunBytes,
  writePhase5RawTempDirectory,
} from './lib/phase5-raw-bundle.mjs';
import { createPhase5RenderRecorder }
  from './lib/phase5-render-recorder.mjs';
import { openPhase5SoakClients }
  from './lib/phase5-soak-clients.mjs';
import { createPhase5SoakOrchestrator }
  from './lib/phase5-soak-orchestrator.mjs';
import { runPhase5SoakSampling }
  from './lib/phase5-soak-sampling.mjs';
import { createPhase5SpeciesRawRecorder }
  from './lib/phase5-species-raw-recorder.mjs';

const REQUIRED = Object.freeze([
  'temporary-evidence', 'phase5-e2e', 'lease-evidence',
  'production-graph', 'production-attestation',
  'listening-checklist', 'equivalence',
]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function cli() {
  const { values } = parseArgs({ options: Object.fromEntries(
    REQUIRED.map((name) => [name, { type: 'string' }]),
  ), allowPositionals: false, strict: true });
  if (REQUIRED.some((name) => typeof values[name] !== 'string')) {
    throw new Error('PHASE5_SOAK_ARGUMENT_REQUIRED');
  }
  const rawFd = process.env.FLOCK_PHASE5_CONTROLLER_FD;
  if (!/^[3-9][0-9]*$/u.test(rawFd ?? '')) {
    throw new Error('PHASE5_CONTROLLER_SESSION_FD_INVALID');
  }
  return Object.freeze({
    controllerFd: Number(rawFd),
    temporaryEvidence: resolve(values['temporary-evidence']),
    phase5E2e: resolve(values['phase5-e2e']),
    leaseEvidence: resolve(values['lease-evidence']),
    productionGraph: resolve(values['production-graph']),
    productionAttestation: resolve(values['production-attestation']),
    listeningChecklist: resolve(values['listening-checklist']),
    equivalence: resolve(values.equivalence),
  });
}

export async function runPhase5RawOnlySoak(options) {
  const transport = createPhase5ControllerFdTransport(options.controllerFd);
  let liveClients = null;
  let recorders = null;
  const controllerSession = createPhase5ControllerSessionClient({
    sendFrame: transport.sendFrame,
    receiveFrame: transport.receiveFrame,
    async handleClientInstruction(instruction) {
      if (liveClients === null) {
        throw new Error('PHASE5_SOAK_CLIENTS_NOT_READY');
      }
      return liveClients.handleInstruction(instruction);
    },
  });
  const orchestrator = createPhase5SoakOrchestrator({
    controllerSession,
    async openClients(admitted) {
      const { binding, window } = admitted.descriptor;
      const clients = admitted.clientCapabilities.map((value) => ({
        client: value.client,
        clientIdentitySha256: value.clientIdentitySha256,
      }));
      recorders = {
        latency: createPhase5LatencyRecorder({ binding, window }),
        render: createPhase5RenderRecorder({ binding, window }),
        client: createPhase5ClientObservationRecorder({
          binding, window, clients,
        }),
        normal: createPhase5SpeciesRawRecorder({ mode: 'normal', binding, window,
          monotonicNow: () => performance.now(), unixNow: () => Date.now() }),
        burst: createPhase5SpeciesRawRecorder({ mode: 'burst', binding, window,
          monotonicNow: () => performance.now(), unixNow: () => Date.now() }),
      };
      liveClients = await openPhase5SoakClients({ admitted,
        latencyRecorder: recorders.latency, clientRecorder: recorders.client });
      return liveClients;
    },
    async sampleWindow({ admitted, clients }) {
      return runPhase5SoakSampling({ admitted, clients,
        latencyRecorder: recorders.latency, renderRecorder: recorders.render,
        normalSpeciesRecorder: recorders.normal,
        burstSpeciesRecorder: recorders.burst });
    },
    async finalizeAndPublish({ admitted, clients, sampled,
      faultEventsBytes, signedClientProjection }) {
      clients.finishRecording();
      const clientObservationsBytes = recorders.client.finalize(
        signedClientProjection,
      );
      const soakRunBytes = buildPhase5SoakRunBytes(
        clientObservationsBytes, admitted.descriptor.window,
      );
      const [phase5E2eBytes, leaseEvidenceBytes, productionGraphBytes,
        productionAttestationBytes, listeningChecklistBytes,
        equivalenceBytes] = await Promise.all([
        options.phase5E2e, options.leaseEvidence, options.productionGraph,
        options.productionAttestation, options.listeningChecklist,
        options.equivalence,
      ].map((path) => readFile(path)));
      const result = await writePhase5RawTempDirectory({
        tempDirectory: options.temporaryEvidence,
        binding: admitted.descriptor.binding,
        window: admitted.descriptor.window,
        evidenceBlobs: {
          faultEventsSha256: faultEventsBytes,
          soakRunSha256: soakRunBytes,
          rawRuntimeReadySamplesSha256: sampled.runtimeReadyBytes,
          rawUiStateLagSamplesSha256: sampled.uiStateLagBytes,
          rawRenderSamplesSha256: sampled.renderBytes,
          clientObservationsSha256: clientObservationsBytes,
          speciesNormalSamplesSha256: sampled.speciesNormalBytes,
          speciesBurstSamplesSha256: sampled.speciesBurstBytes,
          phase5E2eSha256: phase5E2eBytes,
          leaseEvidenceSha256: leaseEvidenceBytes,
        },
        externalBlobs: {
          productionGraphSha256: productionGraphBytes,
          productionMachineAttestationSha256: productionAttestationBytes,
          listeningChecklistSha256: listeningChecklistBytes,
          equivalenceSha256: equivalenceBytes,
        },
      });
      return Object.freeze({
        manifestSha256: sha256(result.manifestBytes),
      });
    },
  });
  try { return await orchestrator.run(); }
  finally { transport.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(
  fileURLToPath(import.meta.url),
)) {
  runPhase5RawOnlySoak(cli()).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; },
  );
}
