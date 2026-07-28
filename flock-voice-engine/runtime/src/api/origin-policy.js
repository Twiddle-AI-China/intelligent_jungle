import { types as utilTypes } from 'node:util';

const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const FUNCTION_PROTOTYPE = Function.prototype;
const GET_PROTOTYPE_OF = Reflect.getPrototypeOf;
const IS_PROMISE = utilTypes.isPromise;
const IS_ASYNC_FUNCTION = utilTypes.isAsyncFunction;
const IS_PROXY = utilTypes.isProxy;
const NOOP = () => undefined;

const SECURITY_HEADERS = new Set([
  'host',
  'origin',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-site',
]);
const SURFACES = new Set([
  'document',
  'static',
  'browserFetch',
  'websocket',
  'opsRead',
  'compatRead',
  'compatWrite',
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const INVALID_HEADER_VALUE = /[\u0000-\u001f\u007f]/;

const ALLOW_BROWSER = Object.freeze({ allowed: true, branch: 'browser' });
const ALLOW_OPS = Object.freeze({ allowed: true, branch: 'ops' });
const BAD_REQUEST = Object.freeze({
  allowed: false,
  statusCode: 400,
  code: 'ORIGIN_POLICY_BAD_REQUEST',
});
const FORWARDED_FORBIDDEN = Object.freeze({
  allowed: false,
  statusCode: 403,
  code: 'ORIGIN_POLICY_FORWARDED_FORBIDDEN',
});
const HOST_MISDIRECTED = Object.freeze({
  allowed: false,
  statusCode: 421,
  code: 'ORIGIN_POLICY_HOST_MISDIRECTED',
});
const REQUEST_FORBIDDEN = Object.freeze({
  allowed: false,
  statusCode: 403,
  code: 'ORIGIN_POLICY_REQUEST_FORBIDDEN',
});

function invalidConfig() {
  throw new Error('ORIGIN_POLICY_CONFIG_INVALID');
}

function unspecifiedHost(hostname) {
  return hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
    || hostname.endsWith('.');
}

function parseCanonicalOrigin(value) {
  if (typeof value !== 'string' || !value.startsWith('http://')) invalidConfig();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidConfig();
  }
  if (parsed.protocol !== 'http:' || parsed.origin !== value
      || parsed.href !== `${value}/` || parsed.username !== '' || parsed.password !== ''
      || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
      || parsed.host.length === 0 || unspecifiedHost(parsed.hostname)) {
    invalidConfig();
  }
  return Object.freeze({ origin: value, authority: parsed.host });
}

function parseOpsAuthorities(value, browserAuthority, authorizeOperationalTransport) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length === 0
      || typeof authorizeOperationalTransport !== 'function') {
    invalidConfig();
  }
  const result = new Set();
  for (const authority of value) {
    if (typeof authority !== 'string' || authority.length === 0
        || authority === browserAuthority || result.has(authority)) {
      invalidConfig();
    }
    let parsed;
    try {
      parsed = new URL(`http://${authority}`);
    } catch {
      invalidConfig();
    }
    if (parsed.origin !== `http://${authority}` || parsed.host !== authority
        || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
        || parsed.username !== '' || parsed.password !== ''
        || unspecifiedHost(parsed.hostname)) {
      invalidConfig();
    }
    result.add(authority);
  }
  return result;
}

function securityHeader(name) {
  return SECURITY_HEADERS.has(name) || name === 'forwarded'
    || name.startsWith('x-forwarded-');
}

function snapshotRawHeaders(value) {
  try {
    if (utilTypes.isProxy(value) || !Array.isArray(value)) return null;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || lengthDescriptor.writable !== true || lengthDescriptor.enumerable !== false
        || lengthDescriptor.configurable !== false
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value === 0 || lengthDescriptor.value % 2 !== 0) {
      return null;
    }
    const snapshot = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
          || descriptor.writable !== true || descriptor.enumerable !== true
          || descriptor.configurable !== true) {
        return null;
      }
      snapshot[index] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function readRawSecurityHeaders(request) {
  let rawHeaders;
  try {
    rawHeaders = snapshotRawHeaders(request?.rawHeaders);
  } catch {
    return null;
  }
  if (rawHeaders === null) return null;
  const values = new Map();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const rawValue = rawHeaders[index + 1];
    if (typeof rawName !== 'string' || !HEADER_NAME.test(rawName)
        || typeof rawValue !== 'string') {
      return null;
    }
    const name = rawName.toLowerCase();
    if (!securityHeader(name)) continue;
    if (INVALID_HEADER_VALUE.test(rawValue) || values.has(name)) {
      return null;
    }
    values.set(name, rawValue);
  }
  if (!values.has('host') || values.get('host').length === 0) return null;
  return values;
}

function hasForwardedHeader(headers) {
  for (const name of headers.keys()) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-')) return true;
  }
  return false;
}

function consumeNativePromise(decision) {
  try {
    Reflect.apply(INTRINSIC_PROMISE_THEN, decision, [NOOP, NOOP]);
  } catch {
    // Best effort only: the trusted callback violated its synchronous contract.
  }
}

function validOperationalAuthorizer(value) {
  if (value === undefined) return true;
  try {
    return typeof value === 'function'
      && !IS_PROXY(value)
      && GET_PROTOTYPE_OF(value) === FUNCTION_PROTOTYPE
      && !IS_ASYNC_FUNCTION(value);
  } catch {
    return false;
  }
}

export function createOriginPolicy({
  canonicalOrigin,
  opsAuthorities,
  authorizeOperationalTransport,
} = {}) {
  // This is a trusted same-process composition seam, not a sandbox. The policy
  // rejects accidental async adapters and requires an exact synchronous boolean.
  if (!validOperationalAuthorizer(authorizeOperationalTransport)) {
    invalidConfig();
  }
  const canonical = parseCanonicalOrigin(canonicalOrigin);
  const operationalAuthorities = parseOpsAuthorities(
    opsAuthorities,
    canonical.authority,
    authorizeOperationalTransport,
  );

  function browserFetch(headers) {
    const origin = headers.get('origin');
    if (origin !== undefined) {
      return origin === canonical.origin ? ALLOW_BROWSER : REQUEST_FORBIDDEN;
    }
    return headers.get('sec-fetch-site') === 'same-origin'
      ? ALLOW_BROWSER : REQUEST_FORBIDDEN;
  }

  function operationalRead(request, headers) {
    if (headers.has('origin') || headers.has('sec-fetch-mode')
        || headers.has('sec-fetch-dest') || headers.has('sec-fetch-site')) {
      return REQUEST_FORBIDDEN;
    }
    let decision;
    try {
      decision = authorizeOperationalTransport?.(request);
    } catch {
      return REQUEST_FORBIDDEN;
    }
    if (decision === true) return ALLOW_OPS;
    if (decision === false) return REQUEST_FORBIDDEN;
    if (IS_PROMISE(decision)) consumeNativePromise(decision);
    return REQUEST_FORBIDDEN;
  }

  function authorize(surface, request) {
    if (!SURFACES.has(surface)) throw new Error('ORIGIN_POLICY_SURFACE_INVALID');
    const headers = readRawSecurityHeaders(request);
    if (headers === null) return BAD_REQUEST;
    if (hasForwardedHeader(headers)) return FORWARDED_FORBIDDEN;

    const host = headers.get('host');
    const browserHost = host === canonical.authority;
    const opsHost = operationalAuthorities.has(host);
    if (surface === 'opsRead') {
      if (!opsHost) return HOST_MISDIRECTED;
      return operationalRead(request, headers);
    }
    if (surface === 'compatRead' || surface === 'compatWrite') {
      if (browserHost) return browserFetch(headers);
      if (opsHost) return operationalRead(request, headers);
      return HOST_MISDIRECTED;
    }
    if (!browserHost) return HOST_MISDIRECTED;

    if (surface === 'static') return ALLOW_BROWSER;
    if (surface === 'browserFetch') return browserFetch(headers);
    if (surface === 'websocket') {
      return headers.get('origin') === canonical.origin
        ? ALLOW_BROWSER : REQUEST_FORBIDDEN;
    }
    const origin = headers.get('origin');
    return headers.get('sec-fetch-mode') === 'navigate'
      && headers.get('sec-fetch-dest') === 'document'
      && (headers.get('sec-fetch-site') === 'none'
        || headers.get('sec-fetch-site') === 'same-origin')
      && (origin === undefined || origin === canonical.origin)
      ? ALLOW_BROWSER : REQUEST_FORBIDDEN;
  }

  return Object.freeze({ authorize });
}
