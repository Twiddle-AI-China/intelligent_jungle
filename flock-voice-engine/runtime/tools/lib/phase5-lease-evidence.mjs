const SURFACES = Object.freeze(['demo', 'tracks', 'new-ui']);
const SPECIES = Object.freeze(['bass', 'pad', 'lead', 'pluck']);
const LEASE_KIND = 'production-fixed-entry-chromium-lease-evidence';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_LIMITS = Object.freeze({
  demo: 12,
  tracks: 16,
  'new-ui': 96,
});
const ENTRY_PATHS = Object.freeze({
  demo: '/demo.html',
  tracks: '/tracks.html',
  'new-ui': '/',
});
const SOCKET_PATHS = Object.freeze({
  demo: Object.freeze(['/decoder']),
  tracks: Object.freeze(['/decoder?split=1']),
  'new-ui': Object.freeze([
    '/api/v1/audio',
    '/api/v1/audio',
    '/api/v1/runtime',
    '/api/v1/runtime',
    '/decoder',
  ]),
});
const KNOWN_SOCKET_PATHS = new Set(
  Object.values(SOCKET_PATHS).flat(),
);
const HTTP_FIELDS = Object.freeze([
  'allowedPathOnly',
  'candidateOriginOnly',
  'directOnly',
  'entryPath',
  'entrySeen',
  'failureFree',
  'getOnly',
  'requestCount',
  'status200Only',
]);
const SOCKET_FIELDS = Object.freeze([
  'framesReceived',
  'framesSent',
  'lifecycle',
  'path',
]);
const PROBE_FIELDS = Object.freeze([
  'commandAccepted',
  'commandSeq',
  'pcmBlocks',
  'peakAbs',
  'releaseAccepted',
  'releaseCommandSeq',
]);

function invalid() {
  throw new Error('PHASE5_PRODUCTION_E2E_REQUIRED');
}

function requireEvidence(condition) {
  if (!condition) invalid();
}

function exactObjectKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((item, index) => value[index] === item);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareOrdinal(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSocketRecords(left, right) {
  return compareOrdinal(left.path, right.path)
    || left.framesSent - right.framesSent
    || left.framesReceived - right.framesReceived;
}

function projectedSocketPath(rawUrl, candidateSocketOrigin) {
  try {
    const parsed = new URL(rawUrl);
    const path = `${parsed.pathname}${parsed.search}`;
    return parsed.origin === candidateSocketOrigin
      && parsed.username === ''
      && parsed.password === ''
      && KNOWN_SOCKET_PATHS.has(path)
      && parsed.hash === ''
      ? path
      : '<invalid>';
  } catch {
    return '<invalid>';
  }
}

function projectedLifecycle(record) {
  return record?.socketError === null
    && record?.closed === true
    && exactArray(record?.lifecycle, ['open', 'close'])
    ? ['open', 'close']
    : ['invalid'];
}

function credentialFreeHttpUrl(url) {
  return url !== null && url.username === '' && url.password === '';
}

function projectedFramesSent(value) {
  return nonNegativeSafeInteger(value) ? value : -1;
}

function projectedFramesReceived(value) {
  return positiveSafeInteger(value) ? value : 0;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function projectSurfaceTransports(rawSurfaces, options) {
  const {
    allowedHttpPaths,
    candidateOrigin,
    surfaceEntryPaths,
  } = options ?? {};
  requireEvidence(
    typeof candidateOrigin === 'string'
      && candidateOrigin.length > 0
      && allowedHttpPaths
      && typeof allowedHttpPaths.has === 'function'
      && surfaceEntryPaths !== null
      && typeof surfaceEntryPaths === 'object',
  );
  let candidateSocketOrigin;
  try {
    const parsedCandidate = new URL(candidateOrigin);
    requireEvidence(parsedCandidate.origin === candidateOrigin);
    const socketProtocol = parsedCandidate.protocol === 'http:'
      ? 'ws:'
      : parsedCandidate.protocol === 'https:'
        ? 'wss:'
        : null;
    requireEvidence(socketProtocol !== null);
    candidateSocketOrigin = `${socketProtocol}//${parsedCandidate.host}`;
  } catch {
    invalid();
  }

  return Object.fromEntries(SURFACES.map((surface) => {
    const raw = rawSurfaces?.[surface];
    const httpRecords = raw?.http;
    const socketRecords = raw?.webSockets;
    requireEvidence(Array.isArray(httpRecords) && Array.isArray(socketRecords));
    const parsedRequests = httpRecords.map((record) => {
      try {
        return new URL(record?.rawUrl);
      } catch {
        return null;
      }
    });
    const entryPath = surfaceEntryPaths[surface];
    const webSockets = socketRecords.map((record) => ({
      path: projectedSocketPath(record?.url, candidateSocketOrigin),
      lifecycle: projectedLifecycle(record),
      framesSent: projectedFramesSent(record?.framesSent),
      framesReceived: projectedFramesReceived(record?.framesReceived),
    })).sort(compareSocketRecords);

    return [surface, {
      http: {
        entryPath,
        entrySeen: parsedRequests.some((url) => credentialFreeHttpUrl(url)
          && url.origin === candidateOrigin
          && url.pathname === entryPath
          && url.search === ''),
        requestCount: httpRecords.length,
        getOnly: httpRecords.every((record) => record?.method === 'GET'),
        status200Only: httpRecords.every((record) => record?.responseStatus === 200),
        candidateOriginOnly: parsedRequests.every((url) => (
          credentialFreeHttpUrl(url) && url.origin === candidateOrigin
        )),
        allowedPathOnly: parsedRequests.every((url) => (
          credentialFreeHttpUrl(url)
            && url.search === ''
            && allowedHttpPaths.has(url.pathname)
        )),
        directOnly: httpRecords.every((record) => (
          record?.responseUrl === record?.rawUrl
            && record?.redirectedFrom === null
            && record?.redirectedTo === null
        )),
        failureFree: httpRecords.every((record) => record?.failureText === null),
      },
      webSockets,
    }];
  }));
}

function validateSurfaceLeases(surfaceLeases) {
  requireEvidence(exactObjectKeys(surfaceLeases, SURFACES));
  for (const surface of ['demo', 'tracks']) {
    const lease = surfaceLeases[surface];
    requireEvidence(exactObjectKeys(lease, ['takeAccepted', 'releaseAccepted']));
    requireEvidence(lease.takeAccepted === true && lease.releaseAccepted === true);
  }
  const newUi = surfaceLeases['new-ui'];
  requireEvidence(exactObjectKeys(newUi, [
    'commandSeq',
    'controlReleaseCommandId',
    'publicOwnerAfterRelease',
    'releaseAccepted',
    'releaseCommandSeq',
    'takeAccepted',
  ]));
  requireEvidence(newUi.takeAccepted === true && newUi.releaseAccepted === true);
  requireEvidence(positiveSafeInteger(newUi.commandSeq));
  requireEvidence(positiveSafeInteger(newUi.releaseCommandSeq));
  requireEvidence(newUi.releaseCommandSeq > newUi.commandSeq);
  requireEvidence(newUi.publicOwnerAfterRelease === 'AGENT');
  requireEvidence(
    typeof newUi.controlReleaseCommandId === 'string'
      && UUID_V4.test(newUi.controlReleaseCommandId),
  );
}

function validateAudibleSpecies(audibleSpecies, newUiLease) {
  requireEvidence(exactObjectKeys(audibleSpecies, SPECIES));
  const commandOrder = [];
  for (const species of SPECIES) {
    const probe = audibleSpecies[species];
    requireEvidence(exactObjectKeys(probe, PROBE_FIELDS));
    requireEvidence(probe.commandAccepted === true && probe.releaseAccepted === true);
    requireEvidence(positiveSafeInteger(probe.commandSeq));
    requireEvidence(positiveSafeInteger(probe.releaseCommandSeq));
    requireEvidence(probe.releaseCommandSeq > probe.commandSeq);
    requireEvidence(
      typeof probe.peakAbs === 'number'
        && Number.isFinite(probe.peakAbs)
        && probe.peakAbs > 1e-7,
    );
    requireEvidence(positiveSafeInteger(probe.pcmBlocks));
    commandOrder.push(probe.commandSeq, probe.releaseCommandSeq);
  }
  commandOrder.push(newUiLease.commandSeq, newUiLease.releaseCommandSeq);
  requireEvidence(commandOrder.every((value, index) => (
    index === 0 || commandOrder[index - 1] < value
  )));
}

function validateSurfaceTransports(surfaceTransports) {
  requireEvidence(exactObjectKeys(surfaceTransports, SURFACES));
  for (const surface of SURFACES) {
    const transport = surfaceTransports[surface];
    requireEvidence(exactObjectKeys(transport, ['http', 'webSockets']));
    const { http, webSockets } = transport;
    requireEvidence(exactObjectKeys(http, HTTP_FIELDS));
    requireEvidence(http.entryPath === ENTRY_PATHS[surface]);
    requireEvidence([
      'entrySeen',
      'getOnly',
      'status200Only',
      'candidateOriginOnly',
      'allowedPathOnly',
      'directOnly',
      'failureFree',
    ].every((field) => http[field] === true));
    requireEvidence(
      positiveSafeInteger(http.requestCount)
        && http.requestCount <= HTTP_LIMITS[surface],
    );

    requireEvidence(Array.isArray(webSockets));
    for (const record of webSockets) {
      requireEvidence(exactObjectKeys(record, SOCKET_FIELDS));
      requireEvidence(typeof record.path === 'string');
      requireEvidence(exactArray(record.lifecycle, ['open', 'close']));
      requireEvidence(nonNegativeSafeInteger(record.framesSent));
      requireEvidence(positiveSafeInteger(record.framesReceived));
    }
    requireEvidence(webSockets.every((record, index) => (
      index === 0 || compareSocketRecords(webSockets[index - 1], record) <= 0
    )));
    requireEvidence(exactArray(
      webSockets.map(({ path }) => path),
      SOCKET_PATHS[surface],
    ));
  }
}

export function validateLeaseEvidence(lease) {
  requireEvidence(exactObjectKeys(lease, [
    'audibleSpecies',
    'kind',
    'schemaVersion',
    'sequence',
    'surfaceLeases',
    'surfaceTransports',
  ]));
  requireEvidence(lease.schemaVersion === 1);
  requireEvidence(lease.kind === LEASE_KIND);
  requireEvidence(exactArray(lease.sequence, SURFACES));
  validateSurfaceLeases(lease.surfaceLeases);
  validateAudibleSpecies(lease.audibleSpecies, lease.surfaceLeases['new-ui']);
  validateSurfaceTransports(lease.surfaceTransports);
  return lease;
}
