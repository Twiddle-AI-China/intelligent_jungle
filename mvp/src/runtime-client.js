const DEFAULT_PROTOCOL_VERSION = 1;
const ROOT_REPLACE_PATH = '';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneFrozen(value) {
  return deepFreeze(structuredClone(value));
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validU32(value) {
  return Number.isInteger(value) && !Object.is(value, -0) && value >= 0 && value <= 0xffff_ffff;
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validAudioStatus(value, { frame = false } = {}) {
  if (!validObject(value)) return false;
  const keys = ['statusRevision', 'runtimeOwner', 'audioOwner', 'workerReady', 'recovering',
    'degraded', 'degradedReason', 'audio', ...(frame ? ['type', 'protocolVersion'] : [])].sort();
  if (Object.keys(value).sort().join(',') !== keys.join(',')) return false;
  if (frame && (value.type !== 'audio.status' || value.protocolVersion !== 1)) return false;
  if (!validU32(value.statusRevision)
      || !['browser', 'server'].includes(value.runtimeOwner)
      || !['legacy', 'world'].includes(value.audioOwner)
      || typeof value.workerReady !== 'boolean' || typeof value.recovering !== 'boolean'
      || typeof value.degraded !== 'boolean'
      || !(value.degradedReason === null || typeof value.degradedReason === 'string')) return false;
  if (value.audio === null) return true;
  const audio = value.audio;
  return validObject(audio)
    && Object.keys(audio).sort().join(',') === ['audioEpoch', 'manifestGeometrySha256', 'sampleRate',
      'blockFrames', 'channels', 'format', 'binaryHeaderVersion', 'headerBytes'].sort().join(',')
    && typeof audio.audioEpoch === 'string' && audio.audioEpoch.length > 0
    && /^[0-9a-f]{64}$/.test(audio.manifestGeometrySha256)
    && Number.isSafeInteger(audio.sampleRate) && audio.sampleRate > 0
    && Number.isSafeInteger(audio.blockFrames) && audio.blockFrames > 0
    && audio.channels === 2 && audio.format === 'f32le'
    && audio.binaryHeaderVersion === 1 && audio.headerBytes === 32;
}

function websocketUrl(baseUrl) {
  const url = new URL('/api/v1/runtime', baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else throw runtimeError('RUNTIME_BASE_URL_INVALID');
  return url.toString();
}

function bootstrapUrl(baseUrl) {
  return new URL('/api/v1/bootstrap', baseUrl).toString();
}

function randomCommandId() {
  const commandId = globalThis.crypto?.randomUUID?.();
  if (typeof commandId !== 'string' || commandId.length === 0) {
    throw runtimeError('RUNTIME_UUID_UNAVAILABLE');
  }
  return commandId;
}

export function createRuntimeClient({
  fetchImpl,
  webSocketFactory,
  baseUrl,
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
}) {
  if (
    typeof fetchImpl !== 'function'
    || typeof webSocketFactory !== 'function'
    || typeof baseUrl !== 'string'
    || protocolVersion !== DEFAULT_PROTOCOL_VERSION
  ) {
    throw runtimeError('RUNTIME_CLIENT_OPTIONS_INVALID');
  }

  let phase = 'idle';
  let clientId = null;
  let worldGeneration = null;
  let revision = 0;
  let eventSeq = 0;
  let publishedSnapshot = null;
  let recordBuffer = null;
  let resumeToken = null;
  let currentSocket = null;
  let nextSocketGeneration = 0;
  let activeSocketGeneration = 0;
  let lifecycleAttempt = 0;
  let explicitDisconnect = false;
  let reconnectQueued = false;
  let connectDeferred = null;
  let resyncRequestKey = null;
  let requiresSnapshotBarrier = false;
  let barrierSnapshotSeen = false;
  let nextSnapshotBarrierId = 0;
  let activeSnapshotBarrier = null;
  let resetEventRequired = false;
  let resetEventSeen = false;
  let publicAudioStatus = null;

  const listeners = new Set();
  const statusListeners = new Set();
  const pendingCommands = new Map();
  const queuedSnapshotBarriers = [];

  function attemptIsActive(attempt) {
    return attempt === lifecycleAttempt
      && !explicitDisconnect
      && phase !== 'closed';
  }

  function getStatus() {
    return Object.freeze({
      phase,
      clientId,
      worldGeneration,
      revision,
      eventSeq,
      runtimeOwner: publicAudioStatus?.runtimeOwner ?? null,
      audioOwner: publicAudioStatus?.audioOwner ?? null,
    });
  }

  function getSnapshot() {
    return publishedSnapshot;
  }

  function notifySnapshot(domainEvents = []) {
    const frozenEvents = cloneFrozen(domainEvents);
    const status = getStatus();
    for (const listener of [...listeners]) {
      try {
        listener(publishedSnapshot, frozenEvents, status);
      } catch {
        // 展示订阅者不能破坏协议游标或其它订阅者。
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw runtimeError('RUNTIME_LISTENER_REQUIRED');
    }
    listeners.add(listener);
    if (publishedSnapshot !== null) {
      try {
        listener(publishedSnapshot, Object.freeze([]), getStatus());
      } catch {
        // 初始展示回调同样与协议状态隔离。
      }
    }
    return () => listeners.delete(listener);
  }

  function publishAudioStatus(value, options = {}) {
    if (!validAudioStatus(value, options)) return false;
    if (publicAudioStatus !== null && value.statusRevision <= publicAudioStatus.statusRevision) return false;
    publicAudioStatus = cloneFrozen(Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['type', 'protocolVersion'].includes(key))));
    for (const listener of [...statusListeners]) {
      try { listener(publicAudioStatus); } catch { /* isolated */ }
    }
    return true;
  }

  function subscribeStatus(listener) {
    if (typeof listener !== 'function') throw runtimeError('RUNTIME_STATUS_LISTENER_REQUIRED');
    statusListeners.add(listener);
    if (publicAudioStatus !== null) {
      try { listener(publicAudioStatus); } catch { /* isolated */ }
    }
    return () => statusListeners.delete(listener);
  }

  function rejectPendingCommands(code, predicate = () => true) {
    for (const [commandId, pending] of pendingCommands) {
      if (!predicate(pending)) continue;
      pendingCommands.delete(commandId);
      pending.reject(runtimeError(code));
    }
  }

  function createSnapshotBarrier(waiters = []) {
    nextSnapshotBarrierId += 1;
    return {
      id: nextSnapshotBarrierId,
      waiters,
    };
  }

  function rejectSnapshotWaiters(code) {
    const barriers = [
      activeSnapshotBarrier,
      ...queuedSnapshotBarriers,
    ];
    activeSnapshotBarrier = null;
    queuedSnapshotBarriers.length = 0;
    for (const barrier of barriers) {
      if (barrier === null) continue;
      for (const waiter of barrier.waiters) {
        waiter.reject(runtimeError(code));
      }
    }
  }

  function resolveActiveSnapshotWaiters() {
    const barrier = activeSnapshotBarrier;
    activeSnapshotBarrier = null;
    if (barrier === null) return;
    for (const waiter of barrier.waiters) waiter.resolve(publishedSnapshot);
  }

  function ensureActiveSnapshotBarrier() {
    if (activeSnapshotBarrier === null) {
      activeSnapshotBarrier = createSnapshotBarrier();
    }
    return activeSnapshotBarrier;
  }

  function changeWorldGeneration(nextGeneration, {
    nextRevision = 0,
    nextEventSeq = 0,
  } = {}) {
    if (nextGeneration === worldGeneration) return false;
    const previousGeneration = worldGeneration;
    worldGeneration = nextGeneration;
    revision = nextRevision;
    eventSeq = nextEventSeq;
    publishedSnapshot = null;
    recordBuffer = null;
    resumeToken = null;
    resyncRequestKey = null;
    barrierSnapshotSeen = false;
    resetEventRequired = false;
    resetEventSeen = false;
    if (previousGeneration !== null) {
      rejectPendingCommands(
        'WORLD_GENERATION_CHANGED',
        (pending) => pending.frame.worldGeneration !== nextGeneration,
      );
    }
    return true;
  }

  function validSnapshotTuple(value, {
    expectedWorldGeneration,
    expectedRevision,
    expectedEventSeq,
  }) {
    return validObject(value)
      && value.protocolVersion === protocolVersion
      && value.worldGeneration === expectedWorldGeneration
      && value.revision === expectedRevision
      && value.eventSeq === expectedEventSeq;
  }

  function installSnapshot(value, {
    expectedWorldGeneration,
    expectedRevision,
    expectedEventSeq,
  }) {
    if (!validSnapshotTuple(value, {
      expectedWorldGeneration,
      expectedRevision,
      expectedEventSeq,
    })) {
      return false;
    }
    const frozen = cloneFrozen(value);
    worldGeneration = expectedWorldGeneration;
    revision = expectedRevision;
    eventSeq = expectedEventSeq;
    publishedSnapshot = frozen;
    recordBuffer = null;
    return true;
  }

  function publishSnapshot(value, options) {
    if (!installSnapshot(value, options)) return false;
    notifySnapshot(options.domainEvents ?? []);
    return true;
  }

  function socketIsOpen() {
    return currentSocket !== null
      && activeSocketGeneration !== 0
      && currentSocket.readyState === 1;
  }

  function sendFrame(frame) {
    if (!socketIsOpen()) return false;
    currentSocket.send(JSON.stringify(frame));
    return true;
  }

  function invalidateFailedSocket(reason = 'RUNTIME_SEND_FAILED') {
    const socket = currentSocket;
    activeSocketGeneration = 0;
    currentSocket = null;
    recordBuffer = null;
    resyncRequestKey = null;
    if (!socket) return;
    try {
      socket.close(1011, reason);
    } catch {
      // 本地 generation 已失效，底层 close 再失败也不能复活旧回调。
    }
  }

  function reconnectAfterTransportFailure({
    rejectCommands = false,
    rejectSnapshots = true,
  } = {}) {
    invalidateFailedSocket();
    if (rejectCommands) rejectPendingCommands('RUNTIME_SEND_FAILED');
    if (rejectSnapshots) rejectSnapshotWaiters('RUNTIME_SEND_FAILED');
    if (phase === 'closed' || explicitDisconnect) return;
    phase = 'reconnecting';
    queueReconnect();
  }

  function makeCommandFrame(name, payload, {
    commandId = randomCommandId(),
    baseRevision = revision,
  } = {}) {
    if (
      typeof name !== 'string'
      || name.length === 0
      || typeof commandId !== 'string'
      || commandId.length === 0
      || !validCursor(baseRevision)
      || typeof worldGeneration !== 'string'
      || worldGeneration.length === 0
    ) {
      throw runtimeError('RUNTIME_COMMAND_INVALID');
    }
    return cloneFrozen({
      type: 'command',
      protocolVersion,
      commandId,
      worldGeneration,
      baseRevision,
      name,
      payload: structuredClone(payload ?? {}),
    });
  }

  function sendSnapshotRequest() {
    if (!socketIsOpen()) return false;
    const barrier = ensureActiveSnapshotBarrier();
    const requestKey = JSON.stringify([
      barrier.id,
      activeSocketGeneration,
      worldGeneration,
      revision,
      eventSeq,
    ]);
    if (resyncRequestKey === requestKey) return true;
    try {
      const frame = makeCommandFrame('snapshot.request', {});
      if (!sendFrame(frame)) throw runtimeError('RUNTIME_SEND_FAILED');
      resyncRequestKey = requestKey;
      return true;
    } catch {
      reconnectAfterTransportFailure();
      return false;
    }
  }

  function beginResync() {
    if (phase === 'closed' || explicitDisconnect) return;
    recordBuffer = null;
    phase = 'resyncing';
    requiresSnapshotBarrier = true;
    ensureActiveSnapshotBarrier();
    sendSnapshotRequest();
  }

  function requestSnapshot() {
    if (phase === 'closed' || explicitDisconnect) {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_CLOSED'));
    }
    if (phase !== 'ready' && phase !== 'resyncing') {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_NOT_READY'));
    }
    let resolveSnapshot;
    let rejectSnapshot;
    const promise = new Promise((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    });
    const barrier = createSnapshotBarrier([{
      resolve: resolveSnapshot,
      reject: rejectSnapshot,
    }]);
    if (activeSnapshotBarrier === null) {
      activeSnapshotBarrier = barrier;
      beginResync();
    } else {
      queuedSnapshotBarriers.push(barrier);
    }
    return promise;
  }

  function finishReady() {
    recordBuffer = null;
    resyncRequestKey = null;
    requiresSnapshotBarrier = false;
    barrierSnapshotSeen = false;
    resetEventRequired = false;
    resetEventSeen = false;
    resolveActiveSnapshotWaiters();

    if (queuedSnapshotBarriers.length > 0) {
      activeSnapshotBarrier = queuedSnapshotBarriers.shift();
      phase = 'resyncing';
      requiresSnapshotBarrier = true;
      sendSnapshotRequest();
      return;
    }

    phase = 'ready';

    if (connectDeferred) {
      connectDeferred.resolve();
      connectDeferred = null;
    }

    for (const pending of pendingCommands.values()) {
      if (pending.frame.worldGeneration !== worldGeneration) {
        pendingCommands.delete(pending.frame.commandId);
        pending.reject(runtimeError('WORLD_GENERATION_CHANGED'));
        continue;
      }
      if (pending.lastSentSocketGeneration === activeSocketGeneration) continue;
      try {
        if (!sendFrame(pending.frame)) {
          throw runtimeError('RUNTIME_SEND_FAILED');
        }
        pending.lastSentSocketGeneration = activeSocketGeneration;
      } catch {
        reconnectAfterTransportFailure({ rejectCommands: true });
        break;
      }
    }
  }

  function handleReady(frame) {
    if (
      frame.protocolVersion !== protocolVersion
      || typeof frame.worldGeneration !== 'string'
      || frame.worldGeneration.length === 0
      || !validCursor(frame.revision)
      || !validCursor(frame.eventSeq)
      || typeof frame.resumeToken !== 'string'
      || frame.resumeToken.length === 0
    ) {
      beginResync();
      return;
    }

    const generationChanged = changeWorldGeneration(
      frame.worldGeneration,
      {
        nextRevision: frame.revision,
        nextEventSeq: frame.eventSeq,
      },
    );

    const snapshotMatches = publishedSnapshot !== null
      && publishedSnapshot.worldGeneration === frame.worldGeneration
      && revision === frame.revision
      && eventSeq === frame.eventSeq;
    if (
      !snapshotMatches
      || (
        requiresSnapshotBarrier
        && !barrierSnapshotSeen
      )
    ) {
      if (generationChanged) {
        revision = frame.revision;
        eventSeq = frame.eventSeq;
      }
      beginResync();
      return;
    }
    if (resetEventRequired && !resetEventSeen) {
      resetEventRequired = false;
      barrierSnapshotSeen = false;
      resyncRequestKey = null;
      beginResync();
      return;
    }
    resumeToken = frame.resumeToken;
    finishReady();
  }

  function handleSnapshot(frame) {
    if (
      frame.protocolVersion !== protocolVersion
      || typeof frame.worldGeneration !== 'string'
      || frame.worldGeneration.length === 0
      || !validCursor(frame.revision)
      || !validCursor(frame.eventSeq)
      || !validObject(frame.snapshot)
    ) {
      beginResync();
      return;
    }
    if (
      frame.worldGeneration === worldGeneration
      && (frame.revision < revision || frame.eventSeq < eventSeq)
    ) {
      beginResync();
      return;
    }

    const previousPhase = phase;
    const generationChanged = changeWorldGeneration(
      frame.worldGeneration,
      {
        nextRevision: frame.revision,
        nextEventSeq: frame.eventSeq,
      },
    );
    if (generationChanged) {
      resetEventRequired = true;
      resetEventSeen = false;
    }
    const notificationAttempt = lifecycleAttempt;
    if (!installSnapshot(frame.snapshot, {
      expectedWorldGeneration: frame.worldGeneration,
      expectedRevision: frame.revision,
      expectedEventSeq: frame.eventSeq,
    })) {
      beginResync();
      return;
    }
    barrierSnapshotSeen = true;
    if (
      generationChanged
      || previousPhase === 'ready'
      || previousPhase === 'resyncing'
    ) {
      ensureActiveSnapshotBarrier();
      phase = 'resyncing';
      requiresSnapshotBarrier = true;
    }
    notifySnapshot();
    if (!attemptIsActive(notificationAttempt)) return;
  }

  function validPatchFrame(frame) {
    if (
      frame.protocolVersion !== protocolVersion
      || frame.worldGeneration !== worldGeneration
      || !validCursor(frame.eventSeq)
      || !validCursor(frame.baseRevision)
      || !validCursor(frame.resultRevision)
      || !validCursor(frame.domainEventCount)
      || frame.eventSeq !== eventSeq + 1
      || frame.baseRevision !== revision
      || frame.resultRevision !== revision + 1
      || !Array.isArray(frame.patch)
      || frame.patch.length !== 1
    ) {
      return false;
    }
    const operation = frame.patch[0];
    return validObject(operation)
      && operation.op === 'replace'
      && operation.path === ROOT_REPLACE_PATH
      && validSnapshotTuple(operation.value, {
        expectedWorldGeneration: frame.worldGeneration,
        expectedRevision: frame.resultRevision,
        expectedEventSeq: frame.eventSeq,
      });
  }

  function commitRecord(buffer) {
    if (!publishSnapshot(buffer.snapshot, {
      expectedWorldGeneration: buffer.worldGeneration,
      expectedRevision: buffer.resultRevision,
      expectedEventSeq: buffer.eventSeq,
      domainEvents: buffer.domainEvents,
    })) {
      beginResync();
    }
  }

  function handleStatePatch(frame) {
    if (frame.worldGeneration !== worldGeneration) return;
    if (phase === 'resyncing') return;
    if (recordBuffer !== null || !validPatchFrame(frame)) {
      beginResync();
      return;
    }

    recordBuffer = {
      worldGeneration: frame.worldGeneration,
      eventSeq: frame.eventSeq,
      baseRevision: frame.baseRevision,
      resultRevision: frame.resultRevision,
      domainEventCount: frame.domainEventCount,
      snapshot: structuredClone(frame.patch[0].value),
      domainEvents: [],
    };
    if (recordBuffer.domainEventCount === 0) {
      const complete = recordBuffer;
      recordBuffer = null;
      commitRecord(complete);
    }
  }

  function handleDomainEvent(frame) {
    if (frame.worldGeneration !== worldGeneration) return;
    if (resetEventRequired && recordBuffer === null) {
      const validReset = (
        !resetEventSeen
        && phase === 'resyncing'
        && barrierSnapshotSeen
        && frame.protocolVersion === protocolVersion
        && revision === 0
        && eventSeq === 0
        && frame.eventSeq === eventSeq
        && frame.eventIndex === 0
        && frame.name === 'world.reset'
        && validObject(frame.payload)
        && frame.payload.worldGeneration === worldGeneration
        && publishedSnapshot !== null
        && publishedSnapshot.worldGeneration === worldGeneration
        && publishedSnapshot.revision === revision
        && publishedSnapshot.eventSeq === eventSeq
      );
      if (!validReset) {
        resetEventRequired = false;
        resetEventSeen = false;
        barrierSnapshotSeen = false;
        resyncRequestKey = null;
        beginResync();
        return;
      }
      resetEventSeen = true;
      notifySnapshot([{
        name: frame.name,
        payload: frame.payload,
      }]);
      return;
    }
    if (
      recordBuffer === null
      && frame.name === 'world.reset'
      && frame.eventSeq === eventSeq
      && frame.eventIndex === 0
    ) {
      beginResync();
      return;
    }
    if (phase === 'resyncing') return;
    if (
      recordBuffer === null
      || frame.protocolVersion !== protocolVersion
      || frame.eventSeq !== recordBuffer.eventSeq
      || frame.eventIndex !== recordBuffer.domainEvents.length
      || frame.eventIndex >= recordBuffer.domainEventCount
      || typeof frame.name !== 'string'
    ) {
      beginResync();
      return;
    }

    recordBuffer.domainEvents.push(cloneFrozen({
      name: frame.name,
      payload: frame.payload,
    }));
    if (recordBuffer.domainEvents.length === recordBuffer.domainEventCount) {
      const complete = recordBuffer;
      recordBuffer = null;
      commitRecord(complete);
    }
  }

  function handleCommandResult(frame) {
    if (
      typeof frame.commandId !== 'string'
      || frame.commandId.length === 0
      || typeof frame.accepted !== 'boolean'
      || typeof frame.code !== 'string'
      || frame.code.length === 0
    ) {
      return;
    }
    const pending = pendingCommands.get(frame.commandId);
    if (!pending) return;
    pendingCommands.delete(frame.commandId);
    pending.resolve(cloneFrozen(frame));
  }

  function handleSocketMessage(event) {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      beginResync();
      return;
    }
    if (!validObject(frame)) {
      beginResync();
      return;
    }

    switch (frame.type) {
      case 'ready':
        handleReady(frame);
        break;
      case 'snapshot':
        handleSnapshot(frame);
        break;
      case 'state.patch':
        handleStatePatch(frame);
        break;
      case 'domain.event':
        handleDomainEvent(frame);
        break;
      case 'command.result':
        handleCommandResult(frame);
        break;
      case 'audio.status':
        if (!validAudioStatus(frame, { frame: true })) beginResync();
        else publishAudioStatus(frame, { frame: true });
        break;
      default:
        beginResync();
    }
  }

  function failConnect(error, attempt) {
    if (!attemptIsActive(attempt)) return;
    if (connectDeferred) {
      connectDeferred.reject(error);
      connectDeferred = null;
    }
    if (!explicitDisconnect) phase = 'idle';
  }

  function failSocketHandshake(attempt) {
    if (!attemptIsActive(attempt)) return;
    invalidateFailedSocket();
    const error = runtimeError('RUNTIME_SEND_FAILED');
    if (connectDeferred) {
      connectDeferred.reject(error);
      connectDeferred = null;
    }
    rejectPendingCommands('RUNTIME_SEND_FAILED');
    rejectSnapshotWaiters('RUNTIME_SEND_FAILED');
    requiresSnapshotBarrier = false;
    barrierSnapshotSeen = false;
    resetEventRequired = false;
    resetEventSeen = false;
    phase = 'idle';
  }

  function failReconnect(attempt) {
    if (!attemptIsActive(attempt)) return;
    invalidateFailedSocket('RUNTIME_RECONNECT_FAILED');
    const error = runtimeError('RUNTIME_RECONNECT_FAILED');
    if (connectDeferred) {
      connectDeferred.reject(error);
      connectDeferred = null;
    }
    rejectPendingCommands('RUNTIME_RECONNECT_FAILED');
    rejectSnapshotWaiters('RUNTIME_RECONNECT_FAILED');
    requiresSnapshotBarrier = false;
    barrierSnapshotSeen = false;
    phase = 'idle';
  }

  function queueReconnect() {
    if (reconnectQueued || explicitDisconnect || phase === 'closed') return;
    const scheduledAttempt = lifecycleAttempt;
    reconnectQueued = true;
    queueMicrotask(async () => {
      reconnectQueued = false;
      if (!attemptIsActive(scheduledAttempt)) return;
      const attempt = lifecycleAttempt + 1;
      lifecycleAttempt = attempt;
      try {
        if (resumeToken !== null) {
          const token = resumeToken;
          resumeToken = null;
          openSocket({ tokenName: 'resumeToken', token, attempt });
        } else {
          await bootstrapAndAttach({ reconnecting: true, attempt });
        }
      } catch {
        failReconnect(attempt);
      }
    });
  }

  function handleSocketClose(capturedGeneration, capturedAttempt) {
    if (
      capturedGeneration !== activeSocketGeneration
      || !attemptIsActive(capturedAttempt)
    ) {
      return;
    }
    activeSocketGeneration = 0;
    currentSocket = null;
    recordBuffer = null;
    resyncRequestKey = null;
    if (explicitDisconnect || phase === 'closed') return;
    phase = 'reconnecting';
    queueReconnect();
  }

  function openSocket({ tokenName, token, attempt }) {
    if (!attemptIsActive(attempt)) return;
    let socket = null;
    try {
      socket = webSocketFactory(websocketUrl(baseUrl));
      const capturedGeneration = nextSocketGeneration + 1;
      nextSocketGeneration = capturedGeneration;
      activeSocketGeneration = capturedGeneration;
      currentSocket = socket;
      phase = 'attaching';

      socket.addEventListener('open', () => {
        if (
          capturedGeneration !== activeSocketGeneration
          || !attemptIsActive(attempt)
        ) {
          return;
        }
        try {
          if (!sendFrame({
            type: 'hello',
            protocolVersion,
            clientId,
            [tokenName]: token,
            worldGeneration,
            lastRevision: revision,
            lastEventSeq: eventSeq,
          })) {
            throw runtimeError('RUNTIME_SEND_FAILED');
          }
        } catch {
          failSocketHandshake(attempt);
        }
      });
      socket.addEventListener('message', (event) => {
        if (
          capturedGeneration !== activeSocketGeneration
          || !attemptIsActive(attempt)
        ) {
          return;
        }
        handleSocketMessage(event);
      });
      socket.addEventListener('close', () => {
        handleSocketClose(capturedGeneration, attempt);
      });
      socket.addEventListener('error', () => {
        // 浏览器随后会给出 close；只在 close 上推进重连 generation。
      });
    } catch {
      if (socket !== null && currentSocket === socket) {
        invalidateFailedSocket('RUNTIME_SOCKET_SETUP_FAILED');
      }
      throw runtimeError('RUNTIME_SOCKET_SETUP_FAILED');
    }
  }

  function validateBootstrap(value) {
    return validObject(value)
      && value.protocolVersion === protocolVersion
      && typeof value.clientId === 'string'
      && value.clientId.length > 0
      && typeof value.bootstrapToken === 'string'
      && value.bootstrapToken.length > 0
      && typeof value.worldGeneration === 'string'
      && value.worldGeneration.length > 0
      && validCursor(value.revision)
      && validCursor(value.eventSeq)
      && validAudioStatus(value.audioStatus)
      && validSnapshotTuple(value.snapshot, {
        expectedWorldGeneration: value.worldGeneration,
        expectedRevision: value.revision,
        expectedEventSeq: value.eventSeq,
      });
  }

  async function bootstrapAndAttach({
    reconnecting = false,
    attempt,
  } = {}) {
    if (!attemptIsActive(attempt)) return;
    phase = 'bootstrapping';
    const response = await fetchImpl(bootstrapUrl(baseUrl));
    if (!attemptIsActive(attempt)) return;
    if (!response || response.ok !== true) {
      throw runtimeError(`RUNTIME_BOOTSTRAP_HTTP_${response?.status ?? 0}`);
    }
    const value = await response.json();
    if (!attemptIsActive(attempt)) return;
    if (!validateBootstrap(value)) {
      throw runtimeError('RUNTIME_BOOTSTRAP_INVALID');
    }
    if (
      reconnecting
      && clientId !== null
      && clientId !== value.clientId
    ) {
      rejectPendingCommands('RUNTIME_CLIENT_ID_CHANGED');
    }
    clientId = value.clientId;
    changeWorldGeneration(value.worldGeneration, {
      nextRevision: value.revision,
      nextEventSeq: value.eventSeq,
    });
    // 同进程 fallback bootstrap 会重复当前 status，不应向订阅者倒放 revision；
    // checkpoint 重启则以更低 revision 或不同的同 revision 状态重建基线。
    const repeatedCurrentStatus = publicAudioStatus !== null
      && value.audioStatus.statusRevision === publicAudioStatus.statusRevision
      && sameJsonValue(value.audioStatus, publicAudioStatus);
    if (!repeatedCurrentStatus && publicAudioStatus !== null
        && value.audioStatus.statusRevision <= publicAudioStatus.statusRevision) {
      publicAudioStatus = null;
    }
    if (!repeatedCurrentStatus) publishAudioStatus(value.audioStatus);
    if (!publishSnapshot(value.snapshot, {
      expectedWorldGeneration: value.worldGeneration,
      expectedRevision: value.revision,
      expectedEventSeq: value.eventSeq,
    })) {
      throw runtimeError('RUNTIME_BOOTSTRAP_SNAPSHOT_INVALID');
    }
    openSocket({
      tokenName: 'bootstrapToken',
      token: value.bootstrapToken,
      attempt,
    });
  }

  function ensureConnectDeferred() {
    if (connectDeferred) return connectDeferred;
    let resolveConnect;
    let rejectConnect;
    const promise = new Promise((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    connectDeferred = {
      promise,
      resolve: resolveConnect,
      reject: rejectConnect,
    };
    return connectDeferred;
  }

  function connect() {
    if (phase === 'closed' || explicitDisconnect) {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_CLOSED'));
    }
    if (phase === 'ready') return Promise.resolve();
    const readiness = ensureConnectDeferred();
    if (phase !== 'idle') return readiness.promise;

    const attempt = lifecycleAttempt + 1;
    lifecycleAttempt = attempt;
    bootstrapAndAttach({ attempt }).catch((error) => {
      failConnect(error, attempt);
    });
    return readiness.promise;
  }

  function disconnect() {
    if (phase === 'closed') return;
    explicitDisconnect = true;
    phase = 'closed';
    lifecycleAttempt += 1;
    recordBuffer = null;
    resumeToken = null;
    resyncRequestKey = null;
    resetEventRequired = false;
    resetEventSeen = false;
    activeSocketGeneration = 0;
    const socket = currentSocket;
    currentSocket = null;
    if (socket) {
      try {
        socket.close(1000, 'CLIENT_DISCONNECT');
      } catch {
        // 终态已本地提交，底层 close 异常不能重新启用连接。
      }
    }
    if (connectDeferred) {
      connectDeferred.reject(runtimeError('RUNTIME_CLIENT_DISCONNECTED'));
      connectDeferred = null;
    }
    rejectPendingCommands('RUNTIME_CLIENT_DISCONNECTED');
    rejectSnapshotWaiters('RUNTIME_CLIENT_DISCONNECTED');
  }

  function command(name, payload, options = {}) {
    if (phase === 'closed' || explicitDisconnect) {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_CLOSED'));
    }
    if (phase !== 'ready') {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_NOT_READY'));
    }

    let frame;
    try {
      frame = makeCommandFrame(name, payload, options);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = pendingCommands.get(frame.commandId);
    if (existing) return existing.promise;

    let resolveCommand;
    let rejectCommand;
    const promise = new Promise((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    const pending = {
      frame,
      promise,
      resolve: resolveCommand,
      reject: rejectCommand,
      lastSentSocketGeneration: 0,
    };
    pendingCommands.set(frame.commandId, pending);
    try {
      if (!sendFrame(frame)) {
        throw runtimeError('RUNTIME_SOCKET_NOT_OPEN');
      } else {
        pending.lastSentSocketGeneration = activeSocketGeneration;
      }
    } catch {
      reconnectAfterTransportFailure();
    }
    return promise;
  }

  return Object.freeze({
    connect,
    disconnect,
    command,
    requestSnapshot,
    getSnapshot,
    getStatus,
    subscribe,
    subscribeStatus,
  });
}
