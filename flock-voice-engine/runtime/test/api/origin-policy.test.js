import assert from 'node:assert/strict';
import test from 'node:test';

import { createOriginPolicy } from '../../src/api/origin-policy.js';

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

test('constructor accepts only an explicit canonical HTTP origin and separate ops authorities', () => {
  assert.doesNotThrow(() => createCandidatePolicy());
  assert.doesNotThrow(() => createOriginPolicy({ canonicalOrigin: PRODUCTION_ORIGIN }));
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
    { canonicalOrigin: CANDIDATE_ORIGIN, opsAuthorities: [CANDIDATE_AUTHORITY],
      authorizeOperationalTransport: () => true },
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
