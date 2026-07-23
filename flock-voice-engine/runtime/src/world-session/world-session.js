import { randomUUID } from 'node:crypto';

import {
  PROTOCOL_VERSION,
  deepFreeze,
  rootReplacePatch,
} from '../protocol/v1.js';
import { createTokenStore } from '../protocol/token-store.js';
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
const PHASE_2_COMMAND_SET = new Set(PHASE_2_KERNEL_COMMANDS);
const SNAPSHOT_REQUEST = 'snapshot.request';
const GATEWAY_DELIVERY_RESULTS = new WeakSet();

function commandResult(commandId, accepted, code, details = {}) {
  return deepFreeze({
    type: 'command.result',
    commandId,
    accepted,
    code,
    ...structuredClone(details),
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
    : PHASE_2_KERNEL_COMMANDS;
  const commands = supplied.filter((name, index) => (
    PHASE_2_COMMAND_SET.has(name) && supplied.indexOf(name) === index
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

    Object.assign(this, {
      worldId,
      seed,
      clock,
      mailbox,
      worldGenerationFactory,
      releaseRevision,
      capabilities: normalizeCapabilities(capabilities),
      journal,
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

    let validSchema = false;
    if (restoredSnapshot) {
      try {
        validSchema = validateRestoredSnapshot(restoredSnapshot) === true;
      } catch {
        validSchema = false;
      }
    }

    const compatibleEnvelope = restoredSnapshot !== null
      && restoredSnapshot.worldId === worldId
      && restoredSnapshot.seed === seed
      && restoredSnapshot.protocolVersion === 1
      && restoredSnapshot.snapshotSchemaVersion === 1;
    const validGeneration = (
      typeof restoredSnapshot?.worldGeneration === 'string'
      && restoredSnapshot.worldGeneration.length > 0
    );
    const validRevision = (
      Number.isSafeInteger(restoredSnapshot?.revision)
      && restoredSnapshot.revision >= 0
    );
    const validEventSeq = (
      Number.isSafeInteger(restoredSnapshot?.eventSeq)
      && restoredSnapshot.eventSeq >= 0
    );
    const restoreAccepted = (
      compatibleEnvelope
      && validSchema
      && validGeneration
      && validRevision
      && validEventSeq
    );

    this.kernel = createKernel({
      seed,
      restoredSnapshot: restoreAccepted
        ? structuredClone(restoredSnapshot)
        : null,
    });

    if (restoreAccepted) {
      this.worldGeneration = restoredSnapshot.worldGeneration;
      this.revision = restoredSnapshot.revision;
      this.eventSeq = restoredSnapshot.eventSeq;
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
        revision: lastRevision,
        eventSeq: lastEventSeq,
      });
      if (!claims || !['bootstrap', 'resume'].includes(claims.kind)) {
        throw new Error('ATTACH_TOKEN_INVALID');
      }

      const replay = this.journal.replayAfter(lastEventSeq, lastRevision);
      const barrierFrames = [];
      let result;
      if (replay === null) {
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
      return true;
    });
  }

  commit(kind, mutation) {
    return this.runExclusive(kind, async () => {
      const draft = await mutation(this);
      return this.commitDraft(draft);
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
      });
      const draft = await this.kernel.applyCommand(
        structuredClone(command),
        context,
      );
      this.commitDraft(draft);

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
            key !== 'accepted' && key !== 'code'
          )),
        ),
      );
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

      this.kernel.dispose?.();
      this.kernel = kernel;
      this.worldGeneration = worldGeneration;
      this.revision = 0;
      this.eventSeq = 0;
      this.journal.clear();
      this.idempotency.clear();
      rotation.commit();

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
    for (const frame of this.recordFrames(record)) {
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
    const snapshot = this.snapshotAt(
      draft.snapshot ?? this.kernel.getSnapshot(),
      resultRevision,
      eventSeq,
    );
    const domainEvents = structuredClone(draft.domainEvents ?? []);
    const record = deepFreeze({
      worldGeneration: this.worldGeneration,
      eventSeq,
      baseRevision,
      resultRevision,
      patch: rootReplacePatch(snapshot),
      domainEvents,
    });

    this.revision = resultRevision;
    this.eventSeq = eventSeq;
    this.journal.append(record);
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.state === 'live') {
        this.enqueueRecord(subscription, record);
      }
    }

    return deepFreeze({
      ...structuredClone(draft),
      snapshot,
      domainEvents,
      audioCommands: structuredClone(draft.audioCommands ?? []),
      revision: this.revision,
      eventSeq: this.eventSeq,
    });
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
