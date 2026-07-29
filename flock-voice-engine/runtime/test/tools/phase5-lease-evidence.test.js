import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJson,
  projectSurfaceTransports,
  validateLeaseEvidence,
} from '../../tools/lib/phase5-lease-evidence.mjs';

const CANDIDATE_ORIGIN = 'http://127.0.0.1:18090';
const SURFACE_ENTRY_PATHS = Object.freeze({
  demo: '/demo.html',
  tracks: '/tracks.html',
  'new-ui': '/',
});
const ALLOWED_HTTP_PATHS = new Set([
  '/',
  '/api/v1/bootstrap',
  '/demo.html',
  '/tracks.html',
]);
const UUID_V4 = '123e4567-e89b-42d3-a456-426614174000';

function validHttp(entryPath, requestCount) {
  return {
    entryPath,
    entrySeen: true,
    requestCount,
    getOnly: true,
    status200Only: true,
    candidateOriginOnly: true,
    allowedPathOnly: true,
    directOnly: true,
    failureFree: true,
  };
}

function socket(path, framesSent, framesReceived) {
  return {
    path,
    lifecycle: ['open', 'close'],
    framesSent,
    framesReceived,
  };
}

function validLeaseEvidence() {
  return {
    schemaVersion: 1,
    kind: 'production-fixed-entry-chromium-lease-evidence',
    sequence: ['demo', 'tracks', 'new-ui'],
    surfaceLeases: {
      demo: { takeAccepted: true, releaseAccepted: true },
      tracks: { takeAccepted: true, releaseAccepted: true },
      'new-ui': {
        takeAccepted: true,
        releaseAccepted: true,
        commandSeq: 9,
        releaseCommandSeq: 10,
        publicOwnerAfterRelease: 'AGENT',
        controlReleaseCommandId: UUID_V4,
      },
    },
    audibleSpecies: {
      bass: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 1,
        releaseCommandSeq: 2,
        peakAbs: 1e-5,
        pcmBlocks: 1,
      },
      pad: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 3,
        releaseCommandSeq: 4,
        peakAbs: 0.2,
        pcmBlocks: 2,
      },
      lead: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 5,
        releaseCommandSeq: 6,
        peakAbs: 0.3,
        pcmBlocks: 3,
      },
      pluck: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 7,
        releaseCommandSeq: 8,
        peakAbs: 1e20,
        pcmBlocks: 4,
      },
    },
    surfaceTransports: {
      demo: {
        http: validHttp('/demo.html', 2),
        webSockets: [socket('/decoder', 1, 3)],
      },
      tracks: {
        http: validHttp('/tracks.html', 3),
        webSockets: [socket('/decoder?split=1', 1, 4)],
      },
      'new-ui': {
        http: validHttp('/', 4),
        webSockets: [
          socket('/api/v1/audio', 0, 2),
          socket('/api/v1/audio', 1, 3),
          socket('/api/v1/runtime', 0, 4),
          socket('/api/v1/runtime', 2, 5),
          socket('/decoder', 1, 1),
        ],
      },
    },
  };
}

function rawHttp(path, extra = {}) {
  const rawUrl = `${CANDIDATE_ORIGIN}${path}`;
  return {
    method: 'GET',
    rawUrl,
    responseUrl: rawUrl,
    responseStatus: 200,
    redirectedFrom: null,
    redirectedTo: null,
    failureText: null,
    ...extra,
  };
}

function rawSocket(path, framesSent, framesReceived, extra = {}) {
  return {
    url: `ws://127.0.0.1:18090${path}`,
    lifecycle: ['open', 'close'],
    framesSent,
    framesReceived,
    socketError: null,
    closed: true,
    ...extra,
  };
}

function validRawSurfaces() {
  return {
    demo: {
      http: [
        rawHttp('/demo.html', { authorization: 'Bearer internal-demo-secret' }),
        rawHttp('/api/v1/bootstrap'),
      ],
      webSockets: [rawSocket('/decoder', 1, 3, {
        credential: 'internal-decoder-secret',
      })],
    },
    tracks: {
      http: [
        rawHttp('/tracks.html'),
        rawHttp('/api/v1/bootstrap'),
        rawHttp('/tracks.html'),
      ],
      webSockets: [rawSocket('/decoder?split=1', 1, 4)],
    },
    'new-ui': {
      http: [
        rawHttp('/'),
        rawHttp('/api/v1/bootstrap'),
        rawHttp('/'),
        rawHttp('/api/v1/bootstrap'),
      ],
      webSockets: [
        rawSocket('/decoder', 1, 1),
        rawSocket('/api/v1/runtime', 2, 5),
        rawSocket('/api/v1/audio', 1, 3),
        rawSocket('/api/v1/runtime', 0, 4),
        rawSocket('/api/v1/audio', 0, 2),
      ],
    },
  };
}

const projectionOptions = Object.freeze({
  candidateOrigin: CANDIDATE_ORIGIN,
  allowedHttpPaths: ALLOWED_HTTP_PATHS,
  surfaceEntryPaths: SURFACE_ENTRY_PATHS,
});

test('canonicalJson is JS-byte-authoritative for key order and number spelling', () => {
  assert.equal(
    canonicalJson({ z: 1e20, a: 1e-5 }),
    '{"a":0.00001,"z":100000000000000000000}',
  );
});

test('surface projector derives exact aggregate evidence and sorts duplicate sockets', () => {
  const projected = projectSurfaceTransports(validRawSurfaces(), projectionOptions);

  assert.deepEqual(projected, validLeaseEvidence().surfaceTransports);
  assert.deepEqual(
    projected['new-ui'].webSockets.map(({ path, framesSent, framesReceived }) => (
      [path, framesSent, framesReceived]
    )),
    [
      ['/api/v1/audio', 0, 2],
      ['/api/v1/audio', 1, 3],
      ['/api/v1/runtime', 0, 4],
      ['/api/v1/runtime', 2, 5],
      ['/decoder', 1, 1],
    ],
  );
});

test('surface projector never persists raw URLs, errors, credentials, or raw close state', () => {
  const raw = validRawSurfaces();
  raw.demo.http[0].failureText = 'request-secret';
  raw.demo.http[0].rawCredential = 'http-secret';
  raw.demo.webSockets[0].socketError = 'socket-secret';
  raw.demo.webSockets[0].authorization = 'ws-secret';

  const projected = projectSurfaceTransports(raw, projectionOptions);
  const encoded = canonicalJson(projected);

  assert.equal(projected.demo.http.failureFree, false);
  assert.notDeepEqual(projected.demo.webSockets[0].lifecycle, ['open', 'close']);
  assert.throws(
    () => validateLeaseEvidence({
      ...validLeaseEvidence(),
      surfaceTransports: projected,
    }),
    /PHASE5_PRODUCTION_E2E_REQUIRED/,
  );
  for (const secret of [
    CANDIDATE_ORIGIN,
    'request-secret',
    'http-secret',
    'socket-secret',
    'ws-secret',
    'rawUrl',
    'responseUrl',
    'redirectedFrom',
    'redirectedTo',
    'failureText',
    'socketError',
    'closed',
  ]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

for (const urlField of ['rawUrl', 'responseUrl']) {
  test(`surface projector rejects HTTP ${urlField} credentials without persisting them`, () => {
    const raw = validRawSurfaces();
    raw.demo.http[0][urlField]
      = 'http://user:secret@127.0.0.1:18090/demo.html';

    const projected = projectSurfaceTransports(raw, projectionOptions);
    const encoded = canonicalJson(projected);

    if (urlField === 'rawUrl') {
      assert.equal(projected.demo.http.entrySeen, false);
      assert.equal(projected.demo.http.candidateOriginOnly, false);
      assert.equal(projected.demo.http.allowedPathOnly, false);
    }
    assert.equal(projected.demo.http.directOnly, false);
    assert.equal(encoded.includes('user'), false);
    assert.equal(encoded.includes('secret'), false);
    assert.throws(
      () => validateLeaseEvidence({
        ...validLeaseEvidence(),
        surfaceTransports: projected,
      }),
      /PHASE5_PRODUCTION_E2E_REQUIRED/,
    );
  });
}

test('surface projector cannot turn an unclosed raw socket into valid lifecycle evidence', () => {
  const raw = validRawSurfaces();
  raw.demo.webSockets[0].closed = false;

  const projected = projectSurfaceTransports(raw, projectionOptions);

  assert.notDeepEqual(projected.demo.webSockets[0].lifecycle, ['open', 'close']);
  assert.throws(
    () => validateLeaseEvidence({
      ...validLeaseEvidence(),
      surfaceTransports: projected,
    }),
    /PHASE5_PRODUCTION_E2E_REQUIRED/,
  );
});

test('surface projector replaces invalid allowed-field values with non-sensitive sentinels', () => {
  const raw = validRawSurfaces();
  raw.demo.webSockets[0].lifecycle = ['open', 'lifecycle-secret', 'close'];
  raw.demo.webSockets[0].framesSent = 'sent-secret';
  raw.demo.webSockets[0].framesReceived = 'received-secret';

  const projected = projectSurfaceTransports(raw, projectionOptions);
  const encoded = canonicalJson(projected);

  assert.deepEqual(projected.demo.webSockets[0], {
    path: '/decoder',
    lifecycle: ['invalid'],
    framesSent: -1,
    framesReceived: 0,
  });
  for (const secret of ['lifecycle-secret', 'sent-secret', 'received-secret']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.throws(
    () => validateLeaseEvidence({
      ...validLeaseEvidence(),
      surfaceTransports: projected,
    }),
    /PHASE5_PRODUCTION_E2E_REQUIRED/,
  );
});

test('surface projector cannot turn a foreign-origin socket into valid path evidence', () => {
  const raw = validRawSurfaces();
  raw.demo.webSockets[0].url = 'ws://evil.example/decoder';

  const projected = projectSurfaceTransports(raw, projectionOptions);

  assert.notEqual(projected.demo.webSockets[0].path, '/decoder');
  assert.equal(canonicalJson(projected).includes('evil.example'), false);
  assert.throws(
    () => validateLeaseEvidence({
      ...validLeaseEvidence(),
      surfaceTransports: projected,
    }),
    /PHASE5_PRODUCTION_E2E_REQUIRED/,
  );
});

test('surface projector sorts by ordinal code units without locale-sensitive APIs', () => {
  const priorLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = () => {
    throw new Error('LOCALE_COMPARE_MUST_NOT_RUN');
  };
  try {
    assert.deepEqual(
      projectSurfaceTransports(validRawSurfaces(), projectionOptions),
      validLeaseEvidence().surfaceTransports,
    );
  } finally {
    String.prototype.localeCompare = priorLocaleCompare;
  }
});

test('exact lease validator accepts the complete contract and returns the lease', () => {
  const lease = validLeaseEvidence();
  assert.equal(validateLeaseEvidence(lease), lease);
});

const invalidLeaseMutations = [
  ['missing surfaceTransports', (lease) => { delete lease.surfaceTransports; }],
  ['top-level maintenanceToken', (lease) => { lease.maintenanceToken = 'secret'; }],
  ['surface lease extra key', (lease) => { lease.surfaceLeases.demo.credential = 'secret'; }],
  ['audible probe credential', (lease) => { lease.audibleSpecies.bass.credential = 'secret'; }],
  ['transport extra key', (lease) => { lease.surfaceTransports.demo.authorization = 'secret'; }],
  ['HTTP record rawUrl', (lease) => {
    lease.surfaceTransports.demo.http.rawUrl = `${CANDIDATE_ORIGIN}/demo.html`;
  }],
  ['WebSocket record socketError', (lease) => {
    lease.surfaceTransports.demo.webSockets[0].socketError = 'secret';
  }],
  ['non UUID command id', (lease) => {
    lease.surfaceLeases['new-ui'].controlReleaseCommandId = 'release-command';
  }],
  ['non-v4 UUID command id', (lease) => {
    lease.surfaceLeases['new-ui'].controlReleaseCommandId
      = '123e4567-e89b-12d3-a456-426614174000';
  }],
  ['uppercase UUID command id', (lease) => {
    lease.surfaceLeases['new-ui'].controlReleaseCommandId
      = '123E4567-E89B-42D3-A456-426614174000';
  }],
  ['boolean sequence', (lease) => { lease.audibleSpecies.bass.commandSeq = true; }],
  ['unsafe sequence', (lease) => {
    lease.surfaceLeases['new-ui'].releaseCommandSeq = 2 ** 53;
  }],
  ['fractional sequence', (lease) => { lease.audibleSpecies.pad.commandSeq = 3.5; }],
  ['zero sequence', (lease) => { lease.audibleSpecies.bass.commandSeq = 0; }],
  ['negative count', (lease) => {
    lease.surfaceTransports.demo.webSockets[0].framesSent = -1;
  }],
  ['reversed release sequence', (lease) => {
    lease.audibleSpecies.bass.releaseCommandSeq = 1;
  }],
  ['NaN peak', (lease) => { lease.audibleSpecies.bass.peakAbs = Number.NaN; }],
  ['infinite peak', (lease) => {
    lease.audibleSpecies.bass.peakAbs = Number.POSITIVE_INFINITY;
  }],
  ['silent peak', (lease) => { lease.audibleSpecies.bass.peakAbs = 1e-7; }],
  ['HTTP invariant false', (lease) => {
    lease.surfaceTransports.demo.http.directOnly = false;
  }],
  ['zero HTTP request count', (lease) => {
    lease.surfaceTransports.demo.http.requestCount = 0;
  }],
  ['HTTP request count over surface limit', (lease) => {
    lease.surfaceTransports.demo.http.requestCount = 13;
  }],
  ['wrong HTTP entry path', (lease) => {
    lease.surfaceTransports.tracks.http.entryPath = '/demo.html';
  }],
  ['wrong WebSocket path multiset', (lease) => {
    lease.surfaceTransports.demo.webSockets[0].path = '/api/v1/audio';
  }],
  ['unsorted WebSocket records', (lease) => {
    lease.surfaceTransports['new-ui'].webSockets.reverse();
  }],
  ['WebSocket error lifecycle', (lease) => {
    lease.surfaceTransports.demo.webSockets[0].lifecycle = ['open', 'error', 'close'];
  }],
  ['WebSocket missing close', (lease) => {
    lease.surfaceTransports.demo.webSockets[0].lifecycle = ['open'];
  }],
  ['zero WebSocket frames received', (lease) => {
    lease.surfaceTransports.demo.webSockets[0].framesReceived = 0;
  }],
  ['missing species', (lease) => { delete lease.audibleSpecies.pluck; }],
  ['extra species', (lease) => {
    lease.audibleSpecies.other = structuredClone(lease.audibleSpecies.bass);
  }],
  ['audible probe extra key', (lease) => {
    lease.audibleSpecies.lead.failureText = 'secret';
  }],
  ['global command order violation', (lease) => {
    lease.audibleSpecies.pad.commandSeq = 2;
  }],
];

for (const [name, mutate] of invalidLeaseMutations) {
  test(`exact lease validator rejects ${name}`, () => {
    const lease = validLeaseEvidence();
    mutate(lease);
    assert.throws(
      () => validateLeaseEvidence(lease),
      /PHASE5_PRODUCTION_E2E_REQUIRED/,
    );
  });
}
