import { randomUUID } from 'node:crypto';

import { createMailbox } from './mailbox.js';

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
    });

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

  resetWorld({ kernel, reason }) {
    return this.runExclusive('world.reset', () => {
      this.kernel.dispose?.();
      this.kernel = kernel;
      this.worldGeneration = this.worldGenerationFactory();
      this.revision = 0;
      this.eventSeq = 0;

      return Object.freeze({
        reason,
        worldGeneration: this.worldGeneration,
        revision: this.revision,
        eventSeq: this.eventSeq,
      });
    });
  }
}
