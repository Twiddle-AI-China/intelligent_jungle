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

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

  const listeners = new Set();
  const pendingCommands = new Map();
  const snapshotWaiters = new Set();

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

  function rejectPendingCommands(code, predicate = () => true) {
    for (const [commandId, pending] of pendingCommands) {
      if (!predicate(pending)) continue;
      pendingCommands.delete(commandId);
      pending.reject(runtimeError(code));
    }
  }

  function rejectSnapshotWaiters(code) {
    for (const waiter of snapshotWaiters) waiter.reject(runtimeError(code));
    snapshotWaiters.clear();
  }

  function resolveSnapshotWaiters() {
    for (const waiter of snapshotWaiters) waiter.resolve(publishedSnapshot);
    snapshotWaiters.clear();
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

  function publishSnapshot(value, {
    expectedWorldGeneration,
    expectedRevision,
    expectedEventSeq,
    domainEvents = [],
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
    notifySnapshot(domainEvents);
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

  function invalidateFailedSocket() {
    const socket = currentSocket;
    activeSocketGeneration = 0;
    currentSocket = null;
    recordBuffer = null;
    resyncRequestKey = null;
    if (!socket) return;
    try {
      socket.close(1011, 'RUNTIME_SEND_FAILED');
    } catch {
      // 本地 generation 已失效，底层 close 再失败也不能复活旧回调。
    }
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
    const requestKey = JSON.stringify([
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
      invalidateFailedSocket();
      rejectSnapshotWaiters('RUNTIME_SEND_FAILED');
      phase = 'reconnecting';
      queueReconnect();
      return false;
    }
  }

  function beginResync() {
    if (phase === 'closed') return;
    recordBuffer = null;
    phase = 'resyncing';
    requiresSnapshotBarrier = true;
    sendSnapshotRequest();
  }

  function requestSnapshot() {
    if (phase === 'closed') {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_CLOSED'));
    }
    if (phase !== 'ready' && phase !== 'resyncing') {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_NOT_READY'));
    }
    const promise = new Promise((resolve, reject) => {
      snapshotWaiters.add({ resolve, reject });
    });
    beginResync();
    return promise;
  }

  function finishReady() {
    phase = 'ready';
    recordBuffer = null;
    resyncRequestKey = null;
    requiresSnapshotBarrier = false;
    barrierSnapshotSeen = false;
    resolveSnapshotWaiters();

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
        invalidateFailedSocket();
        rejectPendingCommands('RUNTIME_SEND_FAILED');
        rejectSnapshotWaiters('RUNTIME_SEND_FAILED');
        phase = 'reconnecting';
        queueReconnect();
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
    if (!publishSnapshot(frame.snapshot, {
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
      phase = 'resyncing';
      requiresSnapshotBarrier = true;
    }
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
    if (
      recordBuffer === null
      && frame.name === 'world.reset'
      && frame.eventSeq === eventSeq
      && frame.eventIndex === 0
    ) {
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
      } catch (error) {
        failConnect(error, attempt);
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
    const socket = webSocketFactory(websocketUrl(baseUrl));
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
        invalidateFailedSocket();
        const error = runtimeError('RUNTIME_SEND_FAILED');
        if (connectDeferred) {
          failConnect(error, attempt);
        } else {
          rejectPendingCommands('RUNTIME_SEND_FAILED');
          rejectSnapshotWaiters('RUNTIME_SEND_FAILED');
          phase = 'idle';
        }
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

  function connect() {
    if (phase === 'closed' || explicitDisconnect) {
      return Promise.reject(runtimeError('RUNTIME_CLIENT_CLOSED'));
    }
    if (phase === 'ready') return Promise.resolve();
    if (connectDeferred) return connectDeferred.promise;

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
    const attempt = lifecycleAttempt + 1;
    lifecycleAttempt = attempt;
    bootstrapAndAttach({ attempt }).catch((error) => {
      failConnect(error, attempt);
    });
    return promise;
  }

  function disconnect() {
    if (phase === 'closed') return;
    explicitDisconnect = true;
    phase = 'closed';
    lifecycleAttempt += 1;
    recordBuffer = null;
    resumeToken = null;
    resyncRequestKey = null;
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
        pendingCommands.delete(frame.commandId);
        rejectCommand(runtimeError('RUNTIME_SOCKET_NOT_OPEN'));
      } else {
        pending.lastSentSocketGeneration = activeSocketGeneration;
      }
    } catch (error) {
      pendingCommands.delete(frame.commandId);
      rejectCommand(error);
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
  });
}
