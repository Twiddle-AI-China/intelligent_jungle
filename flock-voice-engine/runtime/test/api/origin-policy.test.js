import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  authorizeExactIpv4LoopbackTransport,
  createOriginPolicy,
  parseCanonicalRawRequestTarget,
  writeOriginPolicyHttpFailure,
  writeOriginPolicyUpgradeFailure,
} from '../../src/api/origin-policy.js';

const CANDIDATE_ORIGIN = 'http://127.0.0.1:18090';
const CANDIDATE_AUTHORITY = '127.0.0.1:18090';
const PRODUCTION_ORIGIN = 'http://localhost:8090';
const PRODUCTION_AUTHORITY = 'localhost:8090';
const OPS_AUTHORITY = '127.0.0.1:8090';

function request(rawHeaders, operationalTransport = false) {
  return {
    rawHeaders,
    operationalTransport,
    // A policy which reads Node's normalized header map can hide duplicates. Keep
    // deliberately trustworthy-looking values here so every assertion proves that
    // rawHeaders is the sole authority.
    headers: {
      host: CANDIDATE_AUTHORITY,
      origin: CANDIDATE_ORIGIN,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'same-origin',
    },
  };
}

function headers({
  host = CANDIDATE_AUTHORITY,
  origin,
  mode,
  dest,
  site,
  extra = [],
} = {}) {
  const result = ['Host', host];
  if (origin !== undefined) result.push('Origin', origin);
  if (mode !== undefined) result.push('Sec-Fetch-Mode', mode);
  if (dest !== undefined) result.push('Sec-Fetch-Dest', dest);
  if (site !== undefined) result.push('Sec-Fetch-Site', site);
  return [...result, ...extra];
}

function createCandidatePolicy() {
  return createOriginPolicy({
    canonicalOrigin: CANDIDATE_ORIGIN,
    opsAuthorities: [OPS_AUTHORITY],
    authorizeOperationalTransport: (candidate) => candidate.operationalTransport === true,
  });
}

function assertAllowed(result, branch = 'browser') {
  assert.deepEqual(result, { allowed: true, branch });
  assert.equal(Object.isFrozen(result), true);
}

function assertDenied(result, statusCode, code) {
  assert.deepEqual(result, { allowed: false, statusCode, code });
  assert.equal(Object.isFrozen(result), true);
  const rendered = JSON.stringify(result);
  for (const untrusted of [
    'evil.example',
    '0.0.0.0',
    'localhost:8090',
    '127.0.0.1:18090',
  ]) {
    assert.equal(rendered.includes(untrusted), false);
  }
}

test('constructor accepts explicit origins and exact loopback ops authorities', () => {
  assert.doesNotThrow(() => createCandidatePolicy());
  assert.doesNotThrow(() => createOriginPolicy({ canonicalOrigin: PRODUCTION_ORIGIN }));
  assert.doesNotThrow(() => createOriginPolicy({
    canonicalOrigin: CANDIDATE_ORIGIN,
    opsAuthorities: [CANDIDATE_AUTHORITY],
    authorizeOperationalTransport: authorizeExactIpv4LoopbackTransport,
  }));
  const syncMethod = { authorize() { return true; } }.authorize;
  for (const authorizeOperationalTransport of [
    function syncFunction() { return true; },
    () => true,
    syncMethod,
    (() => true).bind(null),
    syncMethod.bind(null),
  ]) {
    assert.doesNotThrow(() => createOriginPolicy({
      canonicalOrigin: CANDIDATE_ORIGIN,
      opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport,
    }));
  }

  const customPrototypeCallable = () => true;
  Object.setPrototypeOf(customPrototypeCallable, Object.create(Function.prototype));
  const invalid = [
    {},
    { canonicalOrigin: '' },
    { canonicalOrigin: 'https://localhost:8090' },
    { canonicalOrigin: 'http://localhost:8090/' },
    { canonicalOrigin: 'http://LOCALHOST:8090' },
    { canonicalOrigin: 'http://localhost:08090' },
    { canonicalOrigin: 'http://user@localhost:8090' },
    { canonicalOrigin: 'http://localhost:8090/path' },
    { canonicalOrigin: 'http://localhost:8090?query' },
    { canonicalOrigin: 'http://0.0.0.0:8090' },
    { canonicalOrigin: 'http://[::]:8090' },
    { canonicalOrigin: 'http://localhost.:8090' },
    { canonicalOrigin: 'http://example.com.:8090' },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: CANDIDATE_AUTHORITY },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY] },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY, OPS_AUTHORITY],
      authorizeOperationalTransport: () => true },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: ['0.0.0.0:8090'],
      authorizeOperationalTransport: () => true },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: ['ops.localhost.:8090'],
      authorizeOperationalTransport: () => true },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: ['127.1:18090'],
      authorizeOperationalTransport: () => true },
    { canonicalOrigin: CANDIDATE_ORIGIN,
      authorizeOperationalTransport: async () => true },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: async () => true },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: async function* asyncTransport() { yield true; } },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: (async () => true).bind(null) },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: (async function* asyncTransport() {
        yield true;
      }).bind(null) },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: new Proxy(async () => true, {}) },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: new Proxy(() => true, {}) },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: function* generatorTransport() { yield true; } },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: (function* generatorTransport() {
        yield true;
      }).bind(null) },
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [OPS_AUTHORITY],
      authorizeOperationalTransport: customPrototypeCallable },
  ];
  for (const options of invalid) {
    assert.throws(() => createOriginPolicy(options), { message: 'ORIGIN_POLICY_CONFIG_INVALID' });
  }
});

test('canonical raw request-target parser rejects every path alias before routing', () => {
  const exact = parseCanonicalRawRequestTarget('/healthz');
  assert.deepEqual(exact, { pathname: '/healthz', hasQuery: false });
  assert.equal(Object.isFrozen(exact), true);
  assert.deepEqual(parseCanonicalRawRequestTarget('/api/v1/bootstrap?cache=0'),
    { pathname: '/api/v1/bootstrap', hasQuery: true });
  assert.deepEqual(parseCanonicalRawRequestTarget('/api/v1/bootstrap?'),
    { pathname: '/api/v1/bootstrap', hasQuery: true });
  for (const rawTarget of [
    undefined,
    null,
    '',
    'healthz',
    'http://127.0.0.1:18090/healthz',
    '//127.0.0.1:18090/healthz',
    '/%68ealthz',
    '/api/%2e%2e/healthz',
    '/api/../healthz',
    '/api/./healthz',
    '/api//healthz',
    '/healthz#fragment',
    '/healthz\\alias',
    '/healthz\u0000',
    '/healthz\r\nForwarded: for=evil',
  ]) {
    assert.equal(parseCanonicalRawRequestTarget(rawTarget), null, String(rawTarget));
  }
});

test('candidate and production profiles accept only their byte-exact browser authority', () => {
  const candidate = createCandidatePolicy();
  const production = createOriginPolicy({ canonicalOrigin: PRODUCTION_ORIGIN });

  assertAllowed(candidate.authorize('static',
    request(headers({ host: CANDIDATE_AUTHORITY }))));
  assertDenied(candidate.authorize('static',
    request(headers({ host: PRODUCTION_AUTHORITY }))),
  421, 'ORIGIN_POLICY_HOST_MISDIRECTED');

  assertAllowed(production.authorize('static',
    request(headers({ host: PRODUCTION_AUTHORITY }))));
  assertDenied(production.authorize('static',
    request(headers({ host: CANDIDATE_AUTHORITY }))),
  421, 'ORIGIN_POLICY_HOST_MISDIRECTED');
});

test('top-level documents require exact navigation metadata and never infer an origin', () => {
  const policy = createCandidatePolicy();
  const allowedCases = [
    headers({ mode: 'navigate', dest: 'document', site: 'none' }),
    headers({ mode: 'navigate', dest: 'document', site: 'same-origin' }),
    headers({ origin: CANDIDATE_ORIGIN, mode: 'navigate', dest: 'document',
      site: 'same-origin' }),
  ];
  for (const rawHeaders of allowedCases) {
    assertAllowed(policy.authorize('document', request(rawHeaders)));
  }

  const rejectedCases = [
    headers({ mode: 'cors', dest: 'document', site: 'same-origin' }),
    headers({ mode: 'navigate', dest: 'empty', site: 'same-origin' }),
    headers({ mode: 'navigate', dest: 'document', site: 'cross-site' }),
    headers({ mode: 'navigate', dest: 'document' }),
    headers({ origin: 'http://evil.example', mode: 'navigate', dest: 'document',
      site: 'same-origin' }),
  ];
  for (const rawHeaders of rejectedCases) {
    assertDenied(policy.authorize('document', request(rawHeaders)),
      403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
  }
});

test('static policy is an exact Host check independent of request.headers aliases', () => {
  const policy = createCandidatePolicy();
  assertAllowed(policy.authorize('static', request(headers())));

  for (const host of [
    'localhost:18090',
    '127.0.0.1',
    '127.0.0.1:8090',
    '[::1]:18090',
    '0.0.0.0:18090',
    '127.0.0.1:18090.',
    '127.0.0.1:18090 ',
  ]) {
    assertDenied(policy.authorize('static', request(headers({ host }))),
      421, 'ORIGIN_POLICY_HOST_MISDIRECTED');
  }
});

test('browser fetch permits exact Origin or an exact same-origin fetch-metadata fallback', () => {
  const policy = createCandidatePolicy();
  assertAllowed(policy.authorize('browserFetch',
    request(headers({ origin: CANDIDATE_ORIGIN }))));
  assertAllowed(policy.authorize('browserFetch',
    request(headers({ site: 'same-origin' }))));

  const rejectedCases = [
    headers(),
    headers({ site: 'none', mode: 'navigate', dest: 'document' }),
    headers({ site: 'cross-site' }),
    headers({ origin: 'null' }),
    headers({ origin: PRODUCTION_ORIGIN }),
    headers({ origin: 'https://127.0.0.1:18090' }),
    headers({ origin: 'http://127.0.0.1:8090' }),
    headers({ origin: 'http://localhost:18090' }),
    headers({ origin: 'http://[::1]:18090' }),
  ];
  for (const rawHeaders of rejectedCases) {
    assertDenied(policy.authorize('browserFetch', request(rawHeaders)),
      403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
  }
});

test('websocket requires byte-exact Host and Origin including scheme and port', () => {
  const policy = createCandidatePolicy();
  assertAllowed(policy.authorize('websocket',
    request(headers({ origin: CANDIDATE_ORIGIN }))));

  for (const origin of [
    undefined,
    'null',
    '',
    'https://127.0.0.1:18090',
    'http://127.0.0.1',
    'http://127.0.0.1:8090',
    'http://localhost:18090',
    'http://[::1]:18090',
    'http://0.0.0.0:18090',
    `${CANDIDATE_ORIGIN}/`,
  ]) {
    assertDenied(policy.authorize('websocket', request(headers({ origin }))),
      403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
  }
});

test('operational reads require a separate authority and injected transport authorization', () => {
  const policy = createCandidatePolicy();
  const rawHeaders = headers({ host: OPS_AUTHORITY });

  assertAllowed(policy.authorize('opsRead', request(rawHeaders, true)), 'ops');
  assertDenied(policy.authorize('opsRead', request(rawHeaders, false)),
    403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
  assertDenied(policy.authorize('opsRead',
    request(headers({ host: OPS_AUTHORITY, origin: CANDIDATE_ORIGIN }), true)),
  403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
  assertDenied(policy.authorize('opsRead',
    request(headers({ host: CANDIDATE_AUTHORITY }), true)),
  421, 'ORIGIN_POLICY_HOST_MISDIRECTED');

  const throwingPolicy = createOriginPolicy({
    canonicalOrigin: CANDIDATE_ORIGIN,
    opsAuthorities: [OPS_AUTHORITY],
    authorizeOperationalTransport() {
      throw new Error('untrusted transport detail');
    },
  });
  assertDenied(throwingPolicy.authorize('opsRead', request(rawHeaders, true)),
    403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
});

test('operational branches reject every browser Origin and fetch-metadata header', () => {
  const policy = createCandidatePolicy();
  for (const surface of ['opsRead', 'compatRead', 'compatWrite']) {
    for (const rawHeaders of [
      headers({ host: OPS_AUTHORITY, origin: CANDIDATE_ORIGIN }),
      headers({ host: OPS_AUTHORITY, mode: 'cors' }),
      headers({ host: OPS_AUTHORITY, dest: 'empty' }),
      headers({ host: OPS_AUTHORITY, site: 'same-origin' }),
      headers({
        host: OPS_AUTHORITY,
        mode: 'navigate',
        dest: 'document',
        site: 'none',
      }),
    ]) {
      assertDenied(policy.authorize(surface, request(rawHeaders, true)),
        403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
    }
  }
});

test('trusted operational seam best-effort consumes accidental native Promise results', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const cases = [
      () => Promise.resolve(true),
      () => Promise.reject(new Error('must be consumed')),
    ];
    for (const authorizeOperationalTransport of cases) {
      const policy = createOriginPolicy({
        canonicalOrigin: CANDIDATE_ORIGIN,
        opsAuthorities: [OPS_AUTHORITY],
        authorizeOperationalTransport,
      });
      assertDenied(policy.authorize('opsRead',
        request(headers({ host: OPS_AUTHORITY }), true)),
      403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
    }
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('best-effort Promise sink never mutates results or touches plain thenables', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const thenReads = { count: 0 };
    const plainThenReads = { count: 0 };
    const plainThenCalls = { count: 0 };
    try {
      const shadowedThen = Promise.reject(new Error('shadowed then rejection'));
      Object.defineProperty(shadowedThen, 'then', {
        configurable: true,
        enumerable: true,
        get() {
          thenReads.count += 1;
          throw new Error('shadowed then must not be read');
        },
      });
      const getterThenable = {};
      Object.defineProperty(getterThenable, 'then', {
        configurable: true,
        enumerable: true,
        get() {
          plainThenReads.count += 1;
          throw new Error('plain thenable getter must not be read');
        },
      });
      const functionThenable = {
        then() {
          plainThenCalls.count += 1;
        },
      };
      const before = [
        Object.getOwnPropertyDescriptors(shadowedThen),
        Object.getOwnPropertyDescriptors(getterThenable),
        Object.getOwnPropertyDescriptors(functionThenable),
      ];

      for (const decision of [
        shadowedThen,
        getterThenable,
        functionThenable,
      ]) {
        const policy = createOriginPolicy({
          canonicalOrigin: CANDIDATE_ORIGIN,
          opsAuthorities: [OPS_AUTHORITY],
          authorizeOperationalTransport: () => decision,
        });
        assertDenied(policy.authorize('opsRead',
          request(headers({ host: OPS_AUTHORITY }), true)),
        403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
      }
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
      assert.deepEqual(unhandled, []);
      assert.equal(thenReads.count, 0);
      assert.equal(plainThenReads.count, 0);
      assert.equal(plainThenCalls.count, 0);
      assert.deepEqual([
        Object.getOwnPropertyDescriptors(shadowedThen),
        Object.getOwnPropertyDescriptors(getterThenable),
        Object.getOwnPropertyDescriptors(functionThenable),
      ], before);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

test('compatibility reads and writes select either the browser branch or the ops branch', () => {
  const policy = createCandidatePolicy();
  for (const surface of ['compatRead', 'compatWrite']) {
    assertAllowed(policy.authorize(surface,
      request(headers({ origin: CANDIDATE_ORIGIN }))), 'browser');
    assertAllowed(policy.authorize(surface,
      request(headers({ site: 'same-origin' }))), 'browser');
    assertAllowed(policy.authorize(surface,
      request(headers({ host: OPS_AUTHORITY }), true)), 'ops');
    assertDenied(policy.authorize(surface,
      request(headers({ host: OPS_AUTHORITY }), false)),
    403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
    assertDenied(policy.authorize(surface,
      request(headers({ host: 'evil.example:8090' }), true)),
    421, 'ORIGIN_POLICY_HOST_MISDIRECTED');
  }
});

test('malformed or duplicated security headers fail with 400 before other decisions', () => {
  const policy = createCandidatePolicy();
  const malformed = [
    undefined,
    null,
    {},
    [],
    ['Host'],
    ['Host', 42],
    [42, CANDIDATE_AUTHORITY],
    ['Bad Header', 'value', 'Host', CANDIDATE_AUTHORITY],
    ['Host', ''],
    ['Host', CANDIDATE_AUTHORITY, 'Origin', CANDIDATE_ORIGIN, 'origin', CANDIDATE_ORIGIN],
    ['Host', CANDIDATE_AUTHORITY, 'HOST', CANDIDATE_AUTHORITY],
    ['Host', CANDIDATE_AUTHORITY, 'Sec-Fetch-Site', 'same-origin',
      'sEc-FeTcH-sItE', 'same-origin'],
    ['Host', CANDIDATE_AUTHORITY, 'Sec-Fetch-Mode', 'navigate',
      'SEC-FETCH-MODE', 'navigate'],
    ['Host', CANDIDATE_AUTHORITY, 'Sec-Fetch-Dest', 'document',
      'sec-fetch-dest', 'document'],
    ['Host', 'evil.example', 'hOsT', CANDIDATE_AUTHORITY,
      'X-Forwarded-Host', CANDIDATE_AUTHORITY],
  ];
  for (const rawHeaders of malformed) {
    assertDenied(policy.authorize('static', request(rawHeaders)),
      400, 'ORIGIN_POLICY_BAD_REQUEST');
  }
});

test('raw header admission rejects proxies, accessors, inheritance and custom descriptors', () => {
  const policy = createCandidatePolicy();
  const inheritedReads = { count: 0 };
  const inherited = new Array(2);
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, {
    0: {
      configurable: true,
      get() {
        inheritedReads.count += 1;
        return 'Host';
      },
    },
    1: {
      configurable: true,
      get() {
        inheritedReads.count += 1;
        return CANDIDATE_AUTHORITY;
      },
    },
  }));

  const getterReads = { count: 0 };
  const getterBacked = new Array(2);
  Object.defineProperties(getterBacked, {
    0: {
      configurable: true,
      enumerable: true,
      get() {
        getterReads.count += 1;
        return 'Host';
      },
    },
    1: {
      configurable: true,
      enumerable: true,
      get() {
        getterReads.count += 1;
        return CANDIDATE_AUTHORITY;
      },
    },
  });

  const customDescriptor = headers();
  Object.defineProperty(customDescriptor, '0', {
    configurable: true,
    enumerable: false,
    value: 'Host',
    writable: true,
  });

  const syntheticProxy = new Proxy(new Array(2), {
    get(target, property, receiver) {
      if (property === '0') return 'Host';
      if (property === '1') return CANDIDATE_AUTHORITY;
      return Reflect.get(target, property, receiver);
    },
  });
  const throwingLengthProxy = new Proxy(headers(), {
    get(target, property, receiver) {
      if (property === 'length') throw new Error('untrusted length getter');
      return Reflect.get(target, property, receiver);
    },
  });
  const throwingIndexProxy = new Proxy(headers(), {
    get(target, property, receiver) {
      if (property === '0') throw new Error('untrusted index getter');
      return Reflect.get(target, property, receiver);
    },
  });
  const revoked = Proxy.revocable(headers(), {});
  revoked.revoke();

  for (const rawHeaders of [
    inherited,
    getterBacked,
    customDescriptor,
    syntheticProxy,
    throwingLengthProxy,
    throwingIndexProxy,
    revoked.proxy,
  ]) {
    assertDenied(policy.authorize('static', request(rawHeaders)),
      400, 'ORIGIN_POLICY_BAD_REQUEST');
  }
  assert.equal(inheritedReads.count, 0);
  assert.equal(getterReads.count, 0);
});

test('Forwarded and every mixed-case X-Forwarded-* header fail with 403 before Host checks', () => {
  const policy = createCandidatePolicy();
  const cases = [
    ['Forwarded', 'for=127.0.0.1'],
    ['fOrWaRdEd', 'host=127.0.0.1:18090'],
    ['X-Forwarded-Host', CANDIDATE_AUTHORITY],
    ['x-FoRwArDeD-pRoTo', 'http'],
    ['X-Forwarded-For', '127.0.0.1'],
    ['X-Forwarded-Prefix', '/'],
    ['X-Forwarded-', 'anything'],
  ];
  for (const forwarded of cases) {
    assertDenied(policy.authorize('static',
      request(headers({ host: 'evil.example:8090', extra: forwarded }))),
    403, 'ORIGIN_POLICY_FORWARDED_FORBIDDEN');
  }
});

test('security decision order is malformed, forwarded, Host, then request policy', () => {
  const policy = createCandidatePolicy();
  assertDenied(policy.authorize('websocket', request([
    'Host', 'evil.example:8090',
    'host', CANDIDATE_AUTHORITY,
    'Forwarded', 'host=evil.example',
    'Origin', 'null',
  ])), 400, 'ORIGIN_POLICY_BAD_REQUEST');
  assertDenied(policy.authorize('websocket', request(headers({
    host: 'evil.example:8090',
    origin: 'null',
    extra: ['Forwarded', 'host=evil.example'],
  }))), 403, 'ORIGIN_POLICY_FORWARDED_FORBIDDEN');
  assertDenied(policy.authorize('websocket', request(headers({
    host: 'evil.example:8090',
    origin: 'null',
  }))), 421, 'ORIGIN_POLICY_HOST_MISDIRECTED');
  assertDenied(policy.authorize('websocket',
    request(headers({ origin: 'null' }))),
  403, 'ORIGIN_POLICY_REQUEST_FORBIDDEN');
});

test('surface names are closed and request failure objects never contain untrusted input', () => {
  const policy = createCandidatePolicy();
  assert.throws(() => policy.authorize('unknown',
    request(headers())), { message: 'ORIGIN_POLICY_SURFACE_INVALID' });

  const result = policy.authorize('websocket', request(headers({
    host: 'evil.example:8090',
    origin: 'http://0.0.0.0:6666',
  })));
  assertDenied(result, 421, 'ORIGIN_POLICY_HOST_MISDIRECTED');
  assert.deepEqual(Object.keys(result).sort(),
    ['allowed', 'code', 'statusCode']);
});

test('exact IPv4 loopback transport authorizer trusts only an exact local socket pair', () => {
  assert.equal(authorizeExactIpv4LoopbackTransport({
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
  }), true);
  for (const candidate of [
    undefined,
    {},
    { socket: {} },
    { socket: { remoteAddress: '127.0.0.1' } },
    { socket: { localAddress: '127.0.0.1' } },
    { socket: { remoteAddress: '::ffff:127.0.0.1', localAddress: '127.0.0.1' } },
    { socket: { remoteAddress: '127.0.0.1', localAddress: '::ffff:127.0.0.1' } },
    { socket: { remoteAddress: '::1', localAddress: '::1' } },
    { socket: { remoteAddress: '127.0.0.2', localAddress: '127.0.0.1' } },
  ]) {
    assert.equal(authorizeExactIpv4LoopbackTransport(candidate), false);
  }
  assert.equal(Object.getPrototypeOf(authorizeExactIpv4LoopbackTransport), Function.prototype);
});

test('loopback transport snapshots one socket reference and rejects throwing or unstable addresses', () => {
  let socketReads = 0;
  const alternatingRequest = {
    get socket() {
      socketReads += 1;
      return socketReads === 1
        ? { remoteAddress: '127.0.0.1', localAddress: '192.168.9.140' }
        : { remoteAddress: '192.168.9.140', localAddress: '127.0.0.1' };
    },
  };
  assert.equal(authorizeExactIpv4LoopbackTransport(alternatingRequest), false);
  assert.equal(socketReads, 1);

  const throwingRequest = {};
  Object.defineProperty(throwingRequest, 'socket', {
    get() {
      throw new Error('request socket unavailable');
    },
  });
  assert.equal(authorizeExactIpv4LoopbackTransport(throwingRequest), false);

  for (const property of ['remoteAddress', 'localAddress']) {
    const socket = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' };
    Object.defineProperty(socket, property, {
      get() {
        throw new Error('address unavailable');
      },
    });
    assert.equal(authorizeExactIpv4LoopbackTransport({ socket }), false);
  }

  let remoteReads = 0;
  let localReads = 0;
  const unstableSocket = {
    get remoteAddress() {
      remoteReads += 1;
      return remoteReads === 1 ? '127.0.0.1' : '192.168.9.140';
    },
    get localAddress() {
      localReads += 1;
      return localReads === 1 ? '127.0.0.1' : '192.168.9.140';
    },
  };
  assert.equal(authorizeExactIpv4LoopbackTransport({ socket: unstableSocket }), false);
  assert.equal(remoteReads, 2);
  assert.equal(localReads, 2);
});

test('HTTP policy failure writer emits only fixed no-store JSON and supports HEAD', () => {
  const decision = createCandidatePolicy().authorize('static',
    request(headers({ host: 'evil.example:8090' })));
  const calls = [];
  const response = {
    writeHead(statusCode, responseHeaders) {
      calls.push(['writeHead', statusCode, responseHeaders]);
    },
    end(body) {
      calls.push(['end', body]);
    },
  };
  writeOriginPolicyHttpFailure(response, decision);
  assert.deepEqual(calls, [
    ['writeHead', 421, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': 42,
      'x-content-type-options': 'nosniff',
    }],
    ['end', '{"error":"ORIGIN_POLICY_HOST_MISDIRECTED"}'],
  ]);

  calls.length = 0;
  writeOriginPolicyHttpFailure(response, decision, { head: true });
  assert.deepEqual(calls, [
    ['writeHead', 421, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': 42,
      'x-content-type-options': 'nosniff',
    }],
    ['end', ''],
  ]);
  const rendered = JSON.stringify(calls);
  for (const forbidden of ['evil.example', 'access-control-allow-origin', 'vary', 'location']) {
    assert.equal(rendered.toLowerCase().includes(forbidden), false);
  }
});

test('upgrade policy failure writer closes with fixed raw HTTP and never emits 101', () => {
  const policy = createCandidatePolicy();
  for (const [decision, expectedStatus] of [
    [policy.authorize('static', request([])), '400 Bad Request'],
    [policy.authorize('static', request(headers({
      extra: ['Forwarded', 'for=evil.example'],
    }))), '403 Forbidden'],
    [policy.authorize('static',
      request(headers({ host: 'evil.example:8090' }))), '421 Misdirected Request'],
  ]) {
    const calls = [];
    writeOriginPolicyUpgradeFailure({
      end(bytes) {
        calls.push(bytes);
      },
    }, decision);
    assert.equal(calls.length, 1);
    const raw = Buffer.from(calls[0]).toString('utf8');
    assert.equal(raw.startsWith(`HTTP/1.1 ${expectedStatus}\r\n`), true);
    assert.equal(raw.includes('\r\nConnection: close\r\n'), true);
    assert.equal(raw.includes('\r\nCache-Control: no-store\r\n'), true);
    assert.equal(raw.includes('\r\nContent-Type: application/json; charset=utf-8\r\n'), true);
    assert.equal(raw.includes('\r\nX-Content-Type-Options: nosniff\r\n'), true);
    assert.equal(raw.endsWith(`\r\n\r\n{"error":"${decision.code}"}`), true);
    assert.equal(raw.includes('101'), false);
    assert.equal(raw.includes('evil.example'), false);
    assert.equal(raw.toLowerCase().includes('access-control-allow-origin'), false);
    assert.equal(raw.toLowerCase().includes('\r\nvary:'), false);
    assert.equal(raw.toLowerCase().includes('\r\nlocation:'), false);
  }
});

test('fixed failure writers reject allowed and fabricated decisions', () => {
  const response = { writeHead() {}, end() {} };
  const socket = { end() {} };
  for (const decision of [
    undefined,
    null,
    {},
    { allowed: true, branch: 'browser' },
    { allowed: false, statusCode: 418, code: 'ORIGIN_POLICY_REQUEST_FORBIDDEN' },
    { allowed: false, statusCode: 403, code: 'FABRICATED' },
  ]) {
    assert.throws(
      () => writeOriginPolicyHttpFailure(response, decision),
      { message: 'ORIGIN_POLICY_FAILURE_INVALID' },
    );
    assert.throws(
      () => writeOriginPolicyUpgradeFailure(socket, decision),
      { message: 'ORIGIN_POLICY_FAILURE_INVALID' },
    );
  }
});

test('failure writers contain synchronous I/O faults with best-effort destroy', () => {
  const decision = createCandidatePolicy().authorize('static',
    request(headers({ host: 'evil.example:8090' })));
  for (const response of [
    {
      destroyed: 0,
      writeHead() {
        throw new Error('write failed');
      },
      end() {
        throw new Error('must not run');
      },
      destroy() {
        this.destroyed += 1;
      },
    },
    {
      destroyed: 0,
      writeHead() {},
      end() {
        throw new Error('end failed');
      },
      destroy() {
        this.destroyed += 1;
      },
    },
    {
      writeHead() {
        throw new Error('write failed');
      },
      destroy() {
        throw new Error('destroy failed');
      },
    },
  ]) {
    assert.doesNotThrow(() => writeOriginPolicyHttpFailure(response, decision));
    if (Object.hasOwn(response, 'destroyed')) assert.equal(response.destroyed, 1);
  }

  for (const socket of [
    {
      destroyed: 0,
      end() {
        throw new Error('end failed');
      },
      destroy() {
        this.destroyed += 1;
      },
    },
    {
      end() {
        throw new Error('end failed');
      },
      destroy() {
        throw new Error('destroy failed');
      },
    },
  ]) {
    assert.doesNotThrow(() => writeOriginPolicyUpgradeFailure(socket, decision));
    if (Object.hasOwn(socket, 'destroyed')) assert.equal(socket.destroyed, 1);
  }
});

test('upgrade failure contains asynchronous socket errors and listener setup faults', async () => {
  const decision = createCandidatePolicy().authorize('static',
    request(headers({ host: 'evil.example:8090' })));
  const socket = new EventEmitter();
  await new Promise((resolve, reject) => {
    socket.end = () => {
      setImmediate(() => {
        try {
          socket.emit('error', new Error('client reset after fixed failure'));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    };
    writeOriginPolicyUpgradeFailure(socket, decision);
  });

  let endCalls = 0;
  let destroyCalls = 0;
  const listenerFault = {
    get once() {
      throw new Error('listener getter failed');
    },
    end() {
      endCalls += 1;
    },
    destroy() {
      destroyCalls += 1;
    },
  };
  assert.doesNotThrow(() => writeOriginPolicyUpgradeFailure(listenerFault, decision));
  assert.equal(endCalls, 0);
  assert.equal(destroyCalls, 1);
});
