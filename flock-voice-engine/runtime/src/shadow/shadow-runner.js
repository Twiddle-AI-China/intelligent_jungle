import {
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from '../domain/simulation-checkpoint.js';
import { createSimulationKernelFactory } from '../simulation-runtime.js';
import { WorldSession } from '../world-session/world-session.js';
import { compareShadowValue } from './compare.js';

const SNAPSHOT_ENVELOPE_KEYS = Object.freeze([
  'worldId',
  'worldGeneration',
  'seed',
  'revision',
  'eventSeq',
  'protocolVersion',
  'snapshotSchemaVersion',
]);

function domainSnapshot(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !SNAPSHOT_ENVELOPE_KEYS.includes(key)),
  );
}

function snapshotEnvelope(snapshot) {
  return Object.fromEntries(SNAPSHOT_ENVELOPE_KEYS.map((key) => [key, snapshot?.[key]]));
}

function expectedSnapshotEnvelope({ seed, worldGeneration, revision, eventSeq }) {
  return {
    worldId: 'default',
    worldGeneration,
    seed,
    revision,
    eventSeq,
    protocolVersion: 1,
    snapshotSchemaVersion: 1,
  };
}

function frameProjection(frames) {
  return frames.map((frame) => {
    if (frame.type === 'state.patch') {
      return {
        type: frame.type,
        protocolVersion: frame.protocolVersion,
        worldGeneration: frame.worldGeneration,
        eventSeq: frame.eventSeq,
        baseRevision: frame.baseRevision,
        resultRevision: frame.resultRevision,
        domainEventCount: frame.domainEventCount,
        patch: frame.patch?.map(({ op, path }) => ({ op, path })),
      };
    }
    return structuredClone(frame);
  });
}

function resolvePayload(specification, initialSnapshot, lastPlacedBird) {
  if (specification === 'initial-melody-address'
    || specification === 'initial-melody-cell') {
    const tree = initialSnapshot.trees.find(({ id }) => id === 'melody');
    const pitchBranchId = tree.birds[0].homeBranch;
    const payload = {
      treeId: tree.id,
      pitchBranchId,
      stepIndex: Math.min(15, Math.floor(initialSnapshot.phase * 16)),
    };
    if (specification === 'initial-melody-address') payload.stepCount = 16;
    return payload;
  }
  if (specification === 'last-placed-bird') return { birdId: lastPlacedBird };
  return structuredClone(specification);
}

function createCandidateSession({ seed, worldGeneration, restoredSnapshot }) {
  return new WorldSession({
    seed,
    createKernel: createSimulationKernelFactory(),
    validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, {
      seed,
      configRevision: SIMULATION_CONFIG_REVISION,
    }),
    restoredSnapshot,
    worldGenerationFactory: () => worldGeneration,
    releaseRevision: 'shadow-test',
  });
}

async function exportCandidate(session) {
  return session.runExclusive('checkpoint.export', (owner) => owner.kernel.exportCheckpoint({
    worldGeneration: owner.worldGeneration,
    revision: owner.revision,
    eventSeq: owner.eventSeq,
  }));
}

function result(matched, comparedTicks, comparedBatches, firstDifference) {
  return Object.freeze({ matched, comparedTicks, comparedBatches, firstDifference });
}

export function createShadowRunner({
  createOracle,
  transformCandidateDraft = (draft) => draft,
  transformCandidateCheckpoint = (checkpoint) => checkpoint,
  transformCandidateFrames = (frames) => frames,
} = {}) {
  if (typeof createOracle !== 'function') throw new Error('SHADOW_ORACLE_FACTORY_REQUIRED');
  for (const transform of [
    transformCandidateDraft,
    transformCandidateCheckpoint,
    transformCandidateFrames,
  ]) {
    if (typeof transform !== 'function') throw new Error('SHADOW_TRANSFORM_INVALID');
  }

  async function runShadowCase(testCase) {
    const {
      seed,
      worldGeneration,
      ticks,
      dtPattern,
      commands = [],
      checkpointAt = null,
      compareFinalCheckpoint = false,
      requiredEvents = [],
      requiredAcceptedCommands = [],
      initialUserTree = null,
      elapsedReference = null,
      invalidDt,
    } = testCase;
    let oracle = createOracle({ seed });
    let session = createCandidateSession({ seed, worldGeneration, restoredSnapshot: null });
    let oracleRevision = 0;
    let oracleEventSeq = 0;
    let comparedTicks = 0;
    let comparedBatches = 0;
    let operationIndex = 0;
    let lastPlacedBird = null;
    const recentExpectedEvents = [];
    const recentActualEvents = [];
    const observedEventNames = new Set();
    const acceptedCommandNames = new Set();
    let initialSnapshot;

    const context = (kind, tick, expectedRng = null, actualRng = null) => ({
      kind,
      tick,
      operationIndex,
      recentExpectedEvents: recentExpectedEvents.slice(-8),
      recentActualEvents: recentActualEvents.slice(-8),
      expectedRng,
      actualRng,
    });

    async function checkpointPair(tick, compareComplete = false) {
      const expectedCheckpoint = oracle.exportCheckpoint({
        worldGeneration,
        revision: oracleRevision,
        eventSeq: oracleEventSeq,
      });
      const actualCheckpoint = transformCandidateCheckpoint(
        await exportCandidate(session),
        { tick, exportIndex: 0 },
      );
      const expectedAgain = oracle.exportCheckpoint({
        worldGeneration,
        revision: oracleRevision,
        eventSeq: oracleEventSeq,
      });
      const actualAgain = transformCandidateCheckpoint(
        await exportCandidate(session),
        { tick, exportIndex: 1 },
      );
      let found = compareShadowValue(
        expectedCheckpoint,
        expectedAgain,
        context('checkpoint', tick),
      ) ?? compareShadowValue(
        actualCheckpoint,
        actualAgain,
        context('checkpoint', tick),
      );
      if (found === null && compareComplete) {
        found = compareShadowValue(
          expectedCheckpoint,
          actualCheckpoint,
          context('checkpoint', tick, expectedCheckpoint.rng, actualCheckpoint.rng),
        );
      }
      if (found === null) {
        found = compareShadowValue(
          expectedCheckpoint.rng,
          actualCheckpoint.rng,
          context('rng', tick, expectedCheckpoint.rng, actualCheckpoint.rng),
        );
      }
      return { found, expectedCheckpoint, actualCheckpoint };
    }

    async function compareDrafts(expectedDraft, actualDraft, tick, baseRevision, baseEventSeq) {
      const pair = await checkpointPair(tick, false);
      const comparisonContext = (kind) => ({
        ...context(
          kind,
          tick,
          pair.expectedCheckpoint.rng,
          pair.actualCheckpoint.rng,
        ),
        recentExpectedEvents: [...recentExpectedEvents, ...expectedDraft.domainEvents].slice(-8),
        recentActualEvents: [...recentActualEvents, ...actualDraft.domainEvents].slice(-8),
      });
      const expectedEnvelope = expectedSnapshotEnvelope({
        seed, worldGeneration, revision: oracleRevision, eventSeq: oracleEventSeq,
      });
      const replay = session.journal.replayAfter(baseEventSeq, baseRevision);
      const actualFrames = replay === null
        ? null
        : transformCandidateFrames(
          replay.flatMap((record) => session.recordFrames(record)),
          { tick, operationIndex },
        );
      const expectedFrames = expectedDraft.changed === true ? [
        {
          type: 'state.patch', protocolVersion: 1, worldGeneration,
          eventSeq: oracleEventSeq, baseRevision, resultRevision: oracleRevision,
          domainEventCount: expectedDraft.domainEvents.length,
          patch: [{ op: 'replace', path: '' }],
        },
        ...expectedDraft.domainEvents.map((event, eventIndex) => ({
          type: 'domain.event', protocolVersion: 1, worldGeneration,
          eventSeq: oracleEventSeq, eventIndex, name: event.name,
          payload: structuredClone(event.payload),
        })),
      ] : [];
      const comparisons = [
        ['envelope', expectedDraft.changed, actualDraft.changed],
        [
          'envelope',
          { revision: oracleRevision, eventSeq: oracleEventSeq },
          { revision: actualDraft.revision, eventSeq: actualDraft.eventSeq },
        ],
        ['commandResult', expectedDraft.commandResult, actualDraft.commandResult],
        ['audioCommands', expectedDraft.audioCommands, actualDraft.audioCommands],
        ['snapshot', expectedDraft.snapshot, domainSnapshot(actualDraft.snapshot)],
        ['events', expectedDraft.domainEvents, actualDraft.domainEvents],
        [
          'envelope',
          expectedEnvelope,
          expectedDraft.changed === true
            ? snapshotEnvelope(actualDraft.snapshot)
            : expectedEnvelope,
        ],
        ['envelope', expectedFrames, actualFrames === null ? null : frameProjection(actualFrames)],
        ['rng', pair.expectedCheckpoint.rng, pair.actualCheckpoint.rng],
      ];
      for (const [kind, expected, actual] of comparisons) {
        const found = compareShadowValue(expected, actual, comparisonContext(kind));
        if (found !== null) return found;
      }
      recentExpectedEvents.push(...expectedDraft.domainEvents);
      recentActualEvents.push(...actualDraft.domainEvents);
      for (const event of expectedDraft.domainEvents) observedEventNames.add(event.name);
      if (expectedDraft.commandResult?.accepted === true) {
        acceptedCommandNames.add(expectedDraft.commandName);
      }
      return pair.found;
    }

    async function runOperation(kind, tick, oracleOperation, candidateOperation) {
      const baseRevision = session.revision;
      const baseEventSeq = session.eventSeq;
      const expectedDraft = oracleOperation();
      const actualDraft = transformCandidateDraft(
        await session.commit(kind, (owner) => candidateOperation(owner.kernel)),
        { kind, tick, operationIndex },
      );
      if (expectedDraft.changed === true) {
        oracleRevision += 1;
        oracleEventSeq += 1;
      }
      const found = await compareDrafts(
        expectedDraft, actualDraft, tick, baseRevision, baseEventSeq,
      );
      if (found === null) comparedBatches += 1;
      operationIndex += 1;
      return { found, expectedDraft };
    }

    try {
      if (initialUserTree !== null) {
        const expectedCheckpoint = oracle.exportCheckpoint({
          worldGeneration, revision: 0, eventSeq: 0,
        });
        const actualCheckpoint = await exportCandidate(session);
        const oracleWire = JSON.parse(JSON.stringify(expectedCheckpoint));
        const candidateWire = JSON.parse(JSON.stringify(actualCheckpoint));
        oracleWire.control.treeControl[initialUserTree] = 'USER';
        oracleWire.control.agentResumeAt[initialUserTree] = null;
        candidateWire.control.treeControl[initialUserTree] = 'USER';
        candidateWire.control.agentResumeAt[initialUserTree] = null;
        oracle.dispose();
        session.kernel.dispose();
        oracle = createOracle({ seed, restoredSnapshot: oracleWire });
        session = createCandidateSession({
          seed, worldGeneration, restoredSnapshot: candidateWire,
        });
      }
      initialSnapshot = oracle.getSnapshot();
      let found = compareShadowValue(
        initialSnapshot,
        session.kernel.getSnapshot(),
        context('snapshot', 0),
      );
      if (found !== null) return result(false, 0, 0, found);
      const initialPair = await checkpointPair(0, true);
      if (initialPair.found !== null) return result(false, 0, 0, initialPair.found);

      if (invalidDt !== undefined) {
        const before = await checkpointPair(0, true);
        let oracleCode = null;
        let candidateCode = null;
        try { oracle.tick(invalidDt); } catch (error) { oracleCode = error.code ?? error.message; }
        try {
          await session.commit(
            'shadow.invalid-tick',
            (owner) => owner.kernel.tick(invalidDt),
          );
        } catch (error) {
          candidateCode = error.code ?? error.message;
        }
        found = compareShadowValue(
          oracleCode,
          candidateCode,
          context('envelope', 0),
        );
        const after = await checkpointPair(0, true);
        found ??= after.found;
        found ??= compareShadowValue(
          before.expectedCheckpoint,
          after.expectedCheckpoint,
          context('checkpoint', 0),
        );
        found ??= compareShadowValue(
          before.actualCheckpoint,
          after.actualCheckpoint,
          context('checkpoint', 0),
        );
        if (oracleCode === null || candidateCode === null) {
          found ??= compareShadowValue('INVALID_SIMULATION_TICK', {
            oracleCode,
            candidateCode,
          }, context('envelope', 0));
        }
        return result(found === null, 0, 0, found);
      }

      for (let tickIndex = 0; tickIndex < ticks; tickIndex += 1) {
        for (const scheduled of commands.filter(({ atTick }) => atTick === tickIndex)) {
          const payload = resolvePayload(scheduled.payload, initialSnapshot, lastPlacedBird);
          const command = { name: scheduled.name, payload };
          const operation = await runOperation(
            'shadow.command',
            tickIndex,
            () => ({ ...oracle.applyCommand(command), commandName: command.name }),
            (kernel) => kernel.applyCommand(command),
          );
          if (operation.found !== null) {
            return result(false, comparedTicks, comparedBatches, operation.found);
          }
          const placed = operation.expectedDraft.commandResult?.placement?.birdId;
          if (Number.isSafeInteger(placed)) lastPlacedBird = placed;
        }

        const dt = dtPattern[tickIndex % dtPattern.length];
        const operation = await runOperation(
          'shadow.tick',
          tickIndex,
          () => oracle.tick(dt),
          (kernel) => kernel.tick(dt),
        );
        if (operation.found !== null) {
          return result(false, comparedTicks, comparedBatches, operation.found);
        }
        comparedTicks += 1;

        if (checkpointAt !== null && comparedTicks === checkpointAt) {
          const beforeRestore = await checkpointPair(comparedTicks, true);
          if (beforeRestore.found !== null) {
            return result(false, comparedTicks, comparedBatches, beforeRestore.found);
          }
          const oracleWire = JSON.parse(JSON.stringify(beforeRestore.expectedCheckpoint));
          const candidateWire = JSON.parse(JSON.stringify(beforeRestore.actualCheckpoint));
          oracle.dispose();
          session.kernel.dispose();
          oracle = createOracle({ seed, restoredSnapshot: oracleWire });
          session = createCandidateSession({
            seed,
            worldGeneration,
            restoredSnapshot: candidateWire,
          });
          const afterRestore = await checkpointPair(comparedTicks, true);
          found = afterRestore.found
            ?? compareShadowValue(
              oracleWire,
              afterRestore.expectedCheckpoint,
              context('checkpoint', comparedTicks),
            )
            ?? compareShadowValue(
              candidateWire,
              afterRestore.actualCheckpoint,
              context('checkpoint', comparedTicks),
            );
          if (found !== null) return result(false, comparedTicks, comparedBatches, found);
        }
      }

      if (compareFinalCheckpoint) {
        const finalPair = await checkpointPair(comparedTicks, true);
        if (finalPair.found !== null) {
          return result(false, comparedTicks, comparedBatches, finalPair.found);
        }
      }
      if (elapsedReference !== null) {
        const reference = createOracle({ seed });
        try {
          let referenceRevision = 0;
          let referenceEventSeq = 0;
          for (let index = 0; index < elapsedReference.ticks; index += 1) {
            const draft = reference.tick(
              elapsedReference.dtPattern[index % elapsedReference.dtPattern.length],
            );
            if (draft.changed === true) {
              referenceRevision += 1;
              referenceEventSeq += 1;
            }
          }
          const mainCheckpoint = oracle.exportCheckpoint({
            worldGeneration, revision: oracleRevision, eventSeq: oracleEventSeq,
          });
          const referenceCheckpoint = reference.exportCheckpoint({
            worldGeneration, revision: referenceRevision, eventSeq: referenceEventSeq,
          });
          found = compareShadowValue(
            { simTime: mainCheckpoint.world.clock.simTime },
            { simTime: referenceCheckpoint.world.clock.simTime },
            context('snapshot', comparedTicks),
          ) ?? compareShadowValue(
            mainCheckpoint.rng,
            referenceCheckpoint.rng,
            context('rng', comparedTicks, mainCheckpoint.rng, referenceCheckpoint.rng),
          ) ?? compareShadowValue(
            mainCheckpoint.control,
            referenceCheckpoint.control,
            context('checkpoint', comparedTicks),
          );
          if (found !== null) return result(false, comparedTicks, comparedBatches, found);
        } finally {
          reference.dispose();
        }
      }
      const missingEvents = requiredEvents.filter((name) => !observedEventNames.has(name));
      if (missingEvents.length > 0) {
        const missing = compareShadowValue(
          requiredEvents,
          [...observedEventNames],
          context('events', comparedTicks),
        );
        return result(false, comparedTicks, comparedBatches, missing);
      }
      const missingAcceptedCommands = requiredAcceptedCommands.filter(
        (name) => !acceptedCommandNames.has(name),
      );
      if (missingAcceptedCommands.length > 0) {
        const missing = compareShadowValue(
          requiredAcceptedCommands,
          [...acceptedCommandNames],
          context('commandResult', comparedTicks),
        );
        return result(false, comparedTicks, comparedBatches, missing);
      }
      return result(true, comparedTicks, comparedBatches, null);
    } finally {
      try { oracle.dispose(); } catch { /* best effort test cleanup */ }
      try { session.kernel.dispose(); } catch { /* best effort test cleanup */ }
    }
  }

  return Object.freeze({ runShadowCase });
}

export function assertShadowMatch(shadowResult) {
  if (shadowResult?.matched === true) return;
  throw new Error(`SHADOW_MISMATCH\n${JSON.stringify(shadowResult?.firstDifference, null, 2)}`);
}
