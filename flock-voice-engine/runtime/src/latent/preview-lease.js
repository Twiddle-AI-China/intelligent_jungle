const VOICES = new Set(['bass', 'pad', 'melody']);
const PREVIEW_TTL_MS = 2_000;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function output(value) {
  return deepFreeze(value);
}

export function createPreviewLease({ audioSink, clock, leaseManager } = {}) {
  if (typeof audioSink?.accept !== 'function' || typeof clock?.now !== 'function'
    || typeof leaseManager?.take !== 'function') {
    throw new Error('PREVIEW_LEASE_CONFIG_INVALID');
  }
  const active = new Map();

  function controlFor(command, { allowExpired = false } = {}) {
    if (!VOICES.has(command?.voice)) return null;
    const lease = leaseManager.get(`latent:${command.voice}`);
    return lease && (allowExpired || lease.expiresAt > clock.now())
      && lease.clientId === command.clientId
      && lease.connectionGeneration === command.connectionGeneration
      && lease.leaseToken === command.leaseToken ? lease : null;
  }

  function start(command = {}) {
    if (!controlFor(command)) return output({ ok: false, code: 'lease_required', changed: false });
    const existing = active.get(command.voice);
    if (existing) {
      const same = existing.clientId === command.clientId
        && existing.connectionGeneration === command.connectionGeneration;
      return output({
        ok: same,
        code: same ? 'already_active' : 'preview_conflict',
        changed: false,
      });
    }
    const acquired = leaseManager.take({
      resource: `preview:${command.voice}`,
      clientId: command.clientId,
      connectionGeneration: command.connectionGeneration,
      ttlMs: PREVIEW_TTL_MS,
    });
    if (!acquired.ok) return output({ ...acquired, changed: false });
    const previewLease = leaseManager.get(`preview:${command.voice}`);
    const audioCommands = deepFreeze([{ type: 'preview.start', voice: command.voice }]);
    try { audioSink.accept(audioCommands); } catch {
      leaseManager.release({
        resource: previewLease.resource,
        clientId: previewLease.clientId,
        connectionGeneration: previewLease.connectionGeneration,
        leaseToken: previewLease.leaseToken,
      });
      return output({ ok: false, code: 'audio_intent_rejected', changed: false, audioCommands: [] });
    }
    active.set(command.voice, previewLease);
    return output({ ok: true, code: 'ok', changed: true, audioCommands });
  }

  function releaseRecords(records) {
    if (records.length === 0) {
      return output({
        ok: true, code: 'not_active', changed: false, audioCommands: [],
        releasedVoices: [], failedVoices: [],
      });
    }
    const audioCommands = [];
    const releasedVoices = [];
    const failedVoices = [];
    for (const lease of records) {
      const voice = lease.resource.slice('preview:'.length);
      const command = deepFreeze([{ type: 'preview.allOff', voice }]);
      try { audioSink.accept(command); } catch {
        failedVoices.push(voice);
        continue;
      }
      leaseManager.release({
        resource: lease.resource,
        clientId: lease.clientId,
        connectionGeneration: lease.connectionGeneration,
        leaseToken: lease.leaseToken,
      });
      active.delete(voice);
      audioCommands.push(command[0]);
      releasedVoices.push(voice);
    }
    return output({
      ok: failedVoices.length === 0,
      code: failedVoices.length === 0 ? 'ok' : 'audio_intent_rejected',
      changed: releasedVoices.length > 0,
      audioCommands,
      releasedVoices,
      failedVoices,
    });
  }

  function stop(command = {}) {
    if (!controlFor(command)) return output({ ok: false, code: 'lease_required', changed: false });
    const lease = active.get(command.voice);
    if (!lease) return output({ ok: true, code: 'not_active', changed: false, audioCommands: [] });
    if (lease.clientId !== command.clientId
      || lease.connectionGeneration !== command.connectionGeneration) {
      return output({ ok: false, code: 'preview_conflict', changed: false });
    }
    return releaseRecords([lease]);
  }

  function controlWillRelease(command = {}) {
    if (!controlFor(command, { allowExpired: true })) {
      return output({ ok: false, code: 'lease_required', changed: false });
    }
    const lease = active.get(command.voice);
    if (!lease) return output({ ok: true, code: 'not_active', changed: false, audioCommands: [] });
    if (lease.clientId !== command.clientId
      || lease.connectionGeneration !== command.connectionGeneration) {
      return output({ ok: false, code: 'preview_conflict', changed: false });
    }
    return releaseRecords([lease]);
  }

  function tick(nowMs = clock.now(), { excludeVoices = [] } = {}) {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('PREVIEW_CLOCK_INVALID');
    const excluded = new Set(excludeVoices);
    const expired = [...active.values()].filter((lease) => {
      const voice = lease.resource.slice('preview:'.length);
      if (excluded.has(voice)) return false;
      const control = leaseManager.get(`latent:${voice}`);
      return lease.expiresAt <= nowMs || !control || control.expiresAt <= nowMs
        || control.clientId !== lease.clientId
        || control.connectionGeneration !== lease.connectionGeneration;
    });
    return releaseRecords(expired);
  }

  function disconnect({ clientId, connectionGeneration } = {}) {
    return releaseRecords([...active.values()].filter((lease) => (
      lease.clientId === clientId && lease.connectionGeneration === connectionGeneration
    )));
  }

  function getPublicState(voice) {
    if (!VOICES.has(voice)) throw new Error('LATENT_VOICE_UNAVAILABLE');
    const lease = active.get(voice);
    return output({
      active: Boolean(lease),
      audible: false,
      phaseGate: 'shadow-no-audio',
      expiresAt: lease?.expiresAt ?? null,
    });
  }

  return Object.freeze({
    start, stop, tick, disconnect, controlWillRelease, getPublicState,
  });
}
