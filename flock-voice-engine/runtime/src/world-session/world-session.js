import { randomUUID } from 'node:crypto';

import {
  LATENT_COMMANDS,
  normalizeLatentCommandPayload,
  PROTOCOL_VERSION,
  deepFreeze,
  rootReplacePatch,
} from '../protocol/v1.js';
import { createTokenStore } from '../protocol/token-store.js';
import { projectAgentStatus } from '../agents/status-projector.js';
import { createJournal } from './journal.js';
import { createMailbox } from './mailbox.js';

const PHASE_2_KERNEL_COMMANDS = Object.freeze([
  'runtime.pause',
  'runtime.resume',
  'sequence.toggle',
  'sequence.place',
  'bird.shoo',
  'transport.setTempo',
  'transport.setMeter',
]);
const RUNTIME_COMMAND_SET = new Set([...PHASE_2_KERNEL_COMMANDS, ...LATENT_COMMANDS]);
const SNAPSHOT_REQUEST = 'snapshot.request';
const GATEWAY_DELIVERY_RESULTS = new WeakSet();

function commandResult(commandId, accepted, code, details = {}) {
  const clonedDetails = structuredClone(details);
  return deepFreeze({
    ...clonedDetails,
    type: 'command.result',
    commandId,
    accepted,
    code,
  });
}

function staleConnectionResult(commandId) {
  const result = commandResult(
    commandId,
    false,
    'STALE_CONNECTION_GENERATION',
  );
  GATEWAY_DELIVERY_RESULTS.add(result);
  return result;
}

export function requiresGatewayDelivery(result) {
  return (
    result !== null
    && typeof result === 'object'
    && GATEWAY_DELIVERY_RESULTS.has(result)
  );
}

function normalizeCapabilities(capabilities) {
  const supplied = Array.isArray(capabilities?.commands)
    ? capabilities.commands
    : [...PHASE_2_KERNEL_COMMANDS, ...LATENT_COMMANDS];
  const commands = supplied.filter((name, index) => (
    RUNTIME_COMMAND_SET.has(name) && supplied.indexOf(name) === index
  ));
  if (!commands.includes(SNAPSHOT_REQUEST)) commands.push(SNAPSHOT_REQUEST);
  return deepFreeze({
    ...structuredClone(capabilities ?? {}),
    commands,
  });
}

function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export class WorldSession {
  constructor({
    worldId = 'default',
    seed,
    createKernel,
    validateRestoredSnapshot,
    clock,
    mailbox = createMailbox(),
    restoredSnapshot = null,
    worldGenerationFactory = randomUUID,
    releaseRevision = 'unknown',
    capabilities,
    journal = createJournal(),
    tokenStore,
    idempotencyCapacity = 1_024,
    getAgentState = null,
  }) {
    if (worldId !== 'default') {
      throw new Error('WORLD_NOT_SUPPORTED');
    }
    if (
      typeof createKernel !== 'function'
      || typeof validateRestoredSnapshot !== 'function'
    ) {
      throw new Error('WORLD_KERNEL_FACTORY_REQUIRED');
    }
    if (!(getAgentState === null || typeof getAgentState === 'function')) {
      throw new Error('AGENT_STATE_PROVIDER_INVALID');
    }

    Object.assign(this, {
      worldId,
      seed,
      clock,
      mailbox,
      worldGenerationFactory,
      releaseRevision,
      capabilities: normalizeCapabilities(capabilities),
      journal,
      getAgentState,
      tokenStore: tokenStore ?? createTokenStore({
        clock: clock ?? { now: () => Date.now() },
      }),
    });
    if (!Number.isSafeInteger(idempotencyCapacity) || idempotencyCapacity <= 0) {
      throw new Error('IDEMPOTENCY_CAPACITY_INVALID');
    }
    this.idempotencyCapacity = idempotencyCapacity;
    this.idempotency = new Map();
    this.subscriptions = new Map();

    let acceptedSnapshot = null;
    if (restoredSnapshot !== null) {
      try {
        if (validateRestoredSnapshot(restoredSnapshot) === true) {
          const cloned = structuredClone(restoredSnapshot);
          const compatibleEnvelope = cloned.worldId === worldId
            && cloned.seed === seed
            && cloned.protocolVersion === 1
            && cloned.snapshotSchemaVersion === 1;
          const validGeneration = typeof cloned.worldGeneration === 'string'
            && cloned.worldGeneration.length > 0;
          const validRevision = Number.isSafeInteger(cloned.revision)
            && cloned.revision >= 0;
          const validEventSeq = Number.isSafeInteger(cloned.eventSeq)
            && cloned.eventSeq >= 0;
          if (compatibleEnvelope && validGeneration && validRevision && validEventSeq) {
            acceptedSnapshot = deepFreeze(cloned);
          }
        }
      } catch {
        acceptedSnapshot = null;
      }
    }
    const restoreAccepted = acceptedSnapshot !== null;

    this.kernel = createKernel({
      seed,
      restoredSnapshot: acceptedSnapshot,
    });

    if (restoreAccepted) {
      this.worldGeneration = acceptedSnapshot.worldGeneration;
      this.revision = acceptedSnapshot.revision;
      this.eventSeq = acceptedSnapshot.eventSeq;
      this.restoreDisposition = 'restored';
    } else {
      this.worldGeneration = worldGenerationFactory();
      this.revision = 0;
      this.eventSeq = 0;
      this.restoreDisposition = restoredSnapshot === null
        ? 'fresh'
        : 'rebuilt-incompatible';
    }
  }

  runExclusive(kind, operation) {
    return this.mailbox.post(kind, () => operation(this));
  }

  readBootstrap({ clientId }) {
    return this.runExclusive('bootstrap.read', () => {
      const snapshot = this.snapshotAt(
        this.kernel.getSnapshot(),
        this.revision,
        this.eventSeq,
      );
      const issued = this.tokenStore.issue({
        worldId: this.worldId,
        worldGeneration: this.worldGeneration,
        clientId,
        revision: this.revision,
        eventSeq: this.eventSeq,
        kind: 'bootstrap',
      });
      return deepFreeze({
        protocolVersion: PROTOCOL_VERSION,
        releaseRevision: this.releaseRevision,
        worldId: this.worldId,
        worldGeneration: this.worldGeneration,
        revision: this.revision,
        eventSeq: this.eventSeq,
        snapshot,
        capabilities: structuredClone(this.capabilities),
        clientId,
        bootstrapToken: issued.token,
        bootstrapExpiresAt: issued.expiresAt,
      });
    });
  }

  attach({
    clientId,
    token,
    worldGeneration,
    lastRevision,
    lastEventSeq,
    egress,
    generation,
  }) {
    return this.runExclusive('runtime.attach', () => {
      if (worldGeneration !== this.worldGeneration) {
        throw new Error('WORLD_GENERATION_MISMATCH');
      }
      if (!validCursor(lastRevision) || !validCursor(lastEventSeq)) {
        throw new Error('ATTACH_CURSOR_INVALID');
      }
      const claims = this.tokenStore.consume(token, {
        worldId: this.worldId,
        worldGeneration,
        clientId,
      });
      if (!claims || !['bootstrap', 'resume'].includes(claims.kind)) {
        throw new Error('ATTACH_TOKEN_INVALID');
      }
      const validAnchor = (
        validCursor(claims.revision)
        && validCursor(claims.eventSeq)
      );
      const cursorMatchesToken = claims.kind === 'bootstrap'
        ? (
          lastRevision === claims.revision
          && lastEventSeq === claims.eventSeq
        )
        : (
          lastRevision >= claims.revision
          && lastEventSeq >= claims.eventSeq
          && lastRevision <= this.revision
          && lastEventSeq <= this.eventSeq
        );
      if (!validAnchor || !cursorMatchesToken) {
        throw new Error('ATTACH_TOKEN_INVALID');
      }

      const replay = this.journal.replayAfter(lastEventSeq, lastRevision);
      const replayReachesHead = Array.isArray(replay) && (
        replay.length === 0
          ? (
            lastRevision === this.revision
            && lastEventSeq === this.eventSeq
          )
          : (
            replay.at(-1).resultRevision === this.revision
            && replay.at(-1).eventSeq === this.eventSeq
          )
      );
      const barrierFrames = [];
      let result;
      if (!replayReachesHead) {
        const snapshot = this.snapshotAt(
          this.kernel.getSnapshot(),
          this.revision,
          this.eventSeq,
        );
        barrierFrames.push(this.snapshotFrame(snapshot));
        result = deepFreeze({ kind: 'snapshot', snapshot });
      } else {
        for (const record of replay) {
          barrierFrames.push(...this.recordFrames(record));
        }
        result = deepFreeze({ kind: 'replay', records: replay });
      }
      barrierFrames.push(this.readyFrame(clientId));

      const previous = this.subscriptions.get(clientId);
      if (previous) {
        try {
          previous.egress.close(4409, 'CONNECTION_REPLACED');
        } catch {
          // 即使旧连接关闭失败，mailbox 仍原子安装新 generation。
        }
      }

      const subscription = {
        clientId,
        generation,
        egress,
        state: 'syncing',
      };
      this.subscriptions.set(clientId, subscription);

      for (const frame of barrierFrames) {
        this.enqueueBarrierFrame(subscription, frame);
      }
      subscription.state = 'live';
      return result;
    });
  }

  detach({ clientId, generation }) {
    return this.runExclusive('runtime.detach', () => {
      const active = this.subscriptions.get(clientId);
      if (!active || active.generation !== generation) return false;
      this.subscriptions.delete(clientId);
      if (typeof this.kernel.disconnect === 'function') {
        const draft = this.kernel.disconnect({
          clientId,
          connectionGeneration: generation,
        });
        this.commitDraft(draft);
      }
      return true;
    });
  }

  commit(kind, mutation) {
    return this.runExclusive(kind, async () => {
      const draft = await mutation(this);
      return this.commitDraft(draft);
    });
  }

  acceptAgentEnvelope(envelope) {
    return this.commit('agent.result', (owner) => {
      if (typeof owner.kernel.setAgentContext !== 'function'
        || typeof owner.kernel.acceptAgentResult !== 'function') {
        throw new Error('AGENTS_UNAVAILABLE');
      }
      owner.kernel.setAgentContext({
        worldGeneration: owner.worldGeneration,
        currentWorldRevision: owner.revision,
      });
      return owner.kernel.acceptAgentResult(envelope);
    });
  }

  executeCommand({ clientId, generation, command }) {
    return this.runExclusive('command.execute', async () => {
      const active = this.subscriptions.get(clientId);
      const commandId = command?.commandId;
      if (!active || active.generation !== generation) {
        return staleConnectionResult(commandId);
      }

      if (
        command?.type !== 'command'
        || command.protocolVersion !== PROTOCOL_VERSION
        || typeof commandId !== 'string'
        || commandId.length === 0
        || typeof command.name !== 'string'
      ) {
        return this.deliverCommandResult(
          active,
          commandResult(commandId, false, 'INVALID_COMMAND'),
        );
      }
      if (command.worldGeneration !== this.worldGeneration) {
        return this.deliverCommandResult(
          active,
          commandResult(
            commandId,
            false,
            'WORLD_GENERATION_MISMATCH',
          ),
        );
      }

      let normalizedCommand = command;
      if (LATENT_COMMANDS.includes(command.name)) {
        const payload = normalizeLatentCommandPayload(command.name, command.payload);
        if (payload === null) {
          return this.deliverCommandResult(
            active,
            commandResult(commandId, false, 'INVALID_COMMAND'),
          );
        }
        normalizedCommand = { ...command, payload };
      }

      const idempotencyKey = JSON.stringify([clientId, commandId]);
      const cached = this.idempotency.get(idempotencyKey);
      if (cached) return this.deliverCommandResult(active, cached);

      if (!validCursor(command.baseRevision) || command.baseRevision !== this.revision) {
        const rejected = commandResult(
          commandId,
          false,
          'REVISION_MISMATCH',
        );
        this.rememberCommandResult(idempotencyKey, rejected);
        return this.deliverCommandResult(active, rejected);
      }

      const context = Object.freeze({
        worldId: this.worldId,
        worldGeneration: this.worldGeneration,
        clientId,
        commandId,
        baseRevision: command.baseRevision,
        connectionGeneration: generation,
      });
      const draft = await this.kernel.applyCommand(
        structuredClone(normalizedCommand),
        context,
      );
      const kernelResult = draft?.commandResult ?? {
        accepted: true,
        code: 'OK',
      };
      const result = commandResult(
        commandId,
        kernelResult.accepted === true,
        kernelResult.code ?? (
          kernelResult.accepted === true ? 'OK' : 'REJECTED'
        ),
        Object.fromEntries(
          Object.entries(kernelResult).filter(([key]) => (
            !['type', 'commandId', 'accepted', 'code'].includes(key)
          )),
        ),
      );
      JSON.stringify(result);
      this.commitDraft(draft);
      this.rememberCommandResult(idempotencyKey, result);
      return this.deliverCommandResult(active, result);
    });
  }

  requestSnapshot({ clientId, generation, command }) {
    return this.runExclusive('snapshot.request', () => {
      const active = this.subscriptions.get(clientId);
      if (!active || active.generation !== generation) {
        if (command) {
          return staleConnectionResult(command.commandId);
        }
        return deepFreeze({
          type: 'snapshot.barrier',
          accepted: false,
          code: 'STALE_CONNECTION_GENERATION',
        });
      }

      if (command && (
        command.type !== 'command'
        || command.protocolVersion !== PROTOCOL_VERSION
        || typeof command.commandId !== 'string'
        || command.commandId.length === 0
        || typeof command.worldGeneration !== 'string'
        || command.worldGeneration.length === 0
        || !validCursor(command.baseRevision)
        || command.name !== SNAPSHOT_REQUEST
      )) {
        return this.deliverCommandResult(
          active,
          commandResult(command?.commandId, false, 'INVALID_COMMAND'),
        );
      }
      if (command && command.worldGeneration !== this.worldGeneration) {
        return this.deliverCommandResult(
          active,
          commandResult(
            command.commandId,
            false,
            'WORLD_GENERATION_MISMATCH',
          ),
        );
      }

      const snapshot = this.snapshotAt(
        this.kernel.getSnapshot(),
        this.revision,
        this.eventSeq,
      );
      const snapshotFrame = this.snapshotFrame(snapshot);
      const ready = this.readyFrame(clientId);

      active.state = 'syncing';
      this.enqueueBarrierFrame(active, snapshotFrame);
      this.enqueueBarrierFrame(active, ready);
      active.state = 'live';
      return deepFreeze({
        type: 'snapshot.barrier',
        accepted: true,
        code: 'OK',
        worldGeneration: this.worldGeneration,
        revision: this.revision,
        eventSeq: this.eventSeq,
        resumeToken: ready.resumeToken,
        resumeExpiresAt: ready.resumeExpiresAt,
      });
    });
  }

  resetWorld({ kernel, reason }) {
    return this.runExclusive('world.reset', () => {
      const worldGeneration = this.worldGenerationFactory();
      if (
        typeof worldGeneration !== 'string'
        || worldGeneration.length === 0
        || worldGeneration === this.worldGeneration
      ) {
        throw new Error('WORLD_GENERATION_INVALID');
      }
      const subscriptions = [...this.subscriptions.values()];
      const tuple = Object.freeze({
        worldGeneration,
        revision: 0,
        eventSeq: 0,
      });
      const resetSnapshot = subscriptions.length === 0
        ? null
        : this.snapshotAt(kernel.getSnapshot(), 0, 0, worldGeneration);
      const snapshotFrame = resetSnapshot === null
        ? null
        : this.snapshotFrame(resetSnapshot, tuple);
      const resetReason = structuredClone(reason);
      const resetEvent = deepFreeze({
        type: 'domain.event',
        protocolVersion: PROTOCOL_VERSION,
        worldGeneration,
        eventSeq: 0,
        eventIndex: 0,
        name: 'world.reset',
        payload: { reason: resetReason, worldGeneration },
      });
      const rotation = this.tokenStore.prepareRotation(
        subscriptions.map(({ clientId }) => ({
          worldId: this.worldId,
          worldGeneration,
          clientId,
          revision: 0,
          eventSeq: 0,
          kind: 'resume',
        })),
      );
      const barriers = subscriptions.map((subscription, index) => ({
        subscription,
        frames: [
          snapshotFrame,
          resetEvent,
          this.readyFrameFromIssued(rotation.issued[index], tuple),
        ],
      }));
      const result = deepFreeze({
        reason: resetReason,
        worldGeneration,
        revision: 0,
        eventSeq: 0,
      });

      const oldKernel = this.kernel;
      this.kernel = kernel;
      this.worldGeneration = worldGeneration;
      this.revision = 0;
      this.eventSeq = 0;
      this.journal.clear();
      this.idempotency.clear();
      rotation.commit();

      if (oldKernel !== kernel) {
        try {
          oldKernel.dispose?.();
        } catch {
          // 新世界已提交；旧 kernel 清理失败不能回滚权威状态。
        }
      }

      for (const { subscription, frames } of barriers) {
        subscription.state = 'syncing';
        let complete = true;
        for (const frame of frames) {
          if (this.tryEnqueue(subscription, frame)) continue;
          complete = false;
          break;
        }
        if (complete) subscription.state = 'live';
      }

      return result;
    });
  }

  snapshotAt(
    kernelSnapshot,
    revision,
    eventSeq,
    worldGeneration = this.worldGeneration,
  ) {
    if (
      kernelSnapshot === null
      || typeof kernelSnapshot !== 'object'
      || Array.isArray(kernelSnapshot)
    ) {
      throw new Error('KERNEL_SNAPSHOT_INVALID');
    }
    const snapshot = structuredClone(kernelSnapshot);
    return deepFreeze({
      ...snapshot,
      ...(this.getAgentState === null
        ? {}
        : { agentStatus: projectAgentStatus(this.getAgentState()) }),
      worldId: this.worldId,
      worldGeneration,
      seed: this.seed,
      revision,
      eventSeq,
      protocolVersion: PROTOCOL_VERSION,
      snapshotSchemaVersion: snapshot.snapshotSchemaVersion ?? 1,
    });
  }

  snapshotFrame(snapshot, {
    worldGeneration = this.worldGeneration,
    revision = this.revision,
    eventSeq = this.eventSeq,
  } = {}) {
    return deepFreeze({
      type: 'snapshot',
      protocolVersion: PROTOCOL_VERSION,
      worldGeneration,
      revision,
      eventSeq,
      snapshot: structuredClone(snapshot),
    });
  }

  readyFrame(clientId) {
    const issued = this.tokenStore.issue({
      worldId: this.worldId,
      worldGeneration: this.worldGeneration,
      clientId,
      revision: this.revision,
      eventSeq: this.eventSeq,
      kind: 'resume',
    });
    return this.readyFrameFromIssued(issued);
  }

  readyFrameFromIssued(issued, {
    worldGeneration = this.worldGeneration,
    revision = this.revision,
    eventSeq = this.eventSeq,
  } = {}) {
    return deepFreeze({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      worldGeneration,
      revision,
      eventSeq,
      resumeToken: issued.token,
      resumeExpiresAt: issued.expiresAt,
    });
  }

  enqueueBarrierFrame(subscription, frame) {
    if (!this.tryEnqueue(subscription, frame)) {
      throw new Error('EGRESS_OVERFLOW');
    }
  }

  tryEnqueue(subscription, frame) {
    let accepted = false;
    try {
      accepted = subscription.egress.enqueue(frame) === true;
    } catch {
      accepted = false;
    }
    if (accepted) return true;

    const active = this.subscriptions.get(subscription.clientId);
    if (active?.generation === subscription.generation) {
      this.subscriptions.delete(subscription.clientId);
    }
    try {
      subscription.egress.close(4410, 'EGRESS_OVERFLOW');
    } catch {
      // 对应的慢 generation 已从 mailbox 状态中精确移除。
    }
    return false;
  }

  enqueueRecord(subscription, record, barrier = false) {
    return this.enqueueFrames(
      subscription,
      this.recordFrames(record),
      barrier,
    );
  }

  enqueueFrames(subscription, frames, barrier = false) {
    for (const frame of frames) {
      if (this.tryEnqueue(subscription, frame)) continue;
      if (barrier) throw new Error('EGRESS_OVERFLOW');
      return false;
    }
    return true;
  }

  recordFrames(record) {
    const frames = [{
      type: 'state.patch',
      protocolVersion: PROTOCOL_VERSION,
      worldGeneration: this.worldGeneration,
      eventSeq: record.eventSeq,
      baseRevision: record.baseRevision,
      resultRevision: record.resultRevision,
      domainEventCount: record.domainEvents.length,
      patch: structuredClone(record.patch),
    }];
    record.domainEvents.forEach((event, eventIndex) => {
      frames.push({
        type: 'domain.event',
        protocolVersion: PROTOCOL_VERSION,
        worldGeneration: this.worldGeneration,
        eventSeq: record.eventSeq,
        eventIndex,
        name: event.name,
        payload: structuredClone(event.payload),
      });
    });

    return frames.map((frame) => deepFreeze(frame));
  }

  commitDraft(draft) {
    if (!draft || draft.changed !== true) {
      return deepFreeze({
        ...structuredClone(draft ?? { changed: false }),
        changed: false,
        revision: this.revision,
        eventSeq: this.eventSeq,
      });
    }

    const baseRevision = this.revision;
    const resultRevision = baseRevision + 1;
    const eventSeq = this.eventSeq + 1;
    if (!Number.isSafeInteger(resultRevision) || !Number.isSafeInteger(eventSeq)) {
      throw new Error('WORLD_CURSOR_EXHAUSTED');
    }
    const clonedDraft = structuredClone(draft);
    const snapshot = this.snapshotAt(
      clonedDraft.snapshot ?? this.kernel.getSnapshot(),
      resultRevision,
      eventSeq,
    );
    const domainEvents = structuredClone(clonedDraft.domainEvents ?? []);
    const audioCommands = structuredClone(clonedDraft.audioCommands ?? []);
    const record = deepFreeze({
      worldGeneration: this.worldGeneration,
      eventSeq,
      baseRevision,
      resultRevision,
      patch: rootReplacePatch(snapshot),
      domainEvents,
    });
    const frames = this.recordFrames(record);
    for (const frame of frames) JSON.stringify(frame);
    const result = deepFreeze({
      ...clonedDraft,
      snapshot,
      domainEvents,
      audioCommands,
      revision: resultRevision,
      eventSeq,
    });

    this.journal.append(record);
    this.revision = resultRevision;
    this.eventSeq = eventSeq;
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.state === 'live') {
        this.enqueueFrames(subscription, frames);
      }
    }

    return result;
  }

  rememberCommandResult(key, result) {
    this.idempotency.set(key, result);
    if (this.idempotency.size > this.idempotencyCapacity) {
      this.idempotency.delete(this.idempotency.keys().next().value);
    }
  }

  deliverCommandResult(subscription, result) {
    const active = this.subscriptions.get(subscription.clientId);
    if (active?.generation === subscription.generation) {
      this.tryEnqueue(subscription, result);
    }
    return result;
  }
}
