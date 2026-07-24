// Provider-free owner 共用的唯一可恢复随机源。

export const DETERMINISTIC_RNG_ALGORITHM = 'mulberry32-v1';

const UINT32_MAX = 0xffff_ffff;
const UINT32_MODULUS = 1n << 32n;
const UINT32_DIVISOR = 4294967296;
const MULBERRY_INCREMENT = 0x6D2B79F5;
const RESTORED_STATE_KEYS = ['drawCount', 'state'];

function deterministicError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalUint32(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= UINT32_MAX;
}

function canonicalDrawCount(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 0;
}

function expectedState(seed, drawCount) {
  return Number(
    (BigInt(seed) + BigInt(drawCount) * BigInt(MULBERRY_INCREMENT))
      % UINT32_MODULUS,
  );
}

function readRestoredState(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const keys = Object.getOwnPropertyNames(value).sort();
    if (keys.length !== RESTORED_STATE_KEYS.length
      || keys.some((key, index) => key !== RESTORED_STATE_KEYS[index])) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const stateDescriptor = descriptors.state;
    const drawCountDescriptor = descriptors.drawCount;
    if (!stateDescriptor?.enumerable || !('value' in stateDescriptor)
      || !drawCountDescriptor?.enumerable || !('value' in drawCountDescriptor)) return null;
    return {
      state: stateDescriptor.value,
      drawCount: drawCountDescriptor.value,
    };
  } catch {
    return null;
  }
}

export function assertCanonicalSeed(seed) {
  if (!canonicalUint32(seed)) {
    throw deterministicError('INVALID_DETERMINISTIC_RNG_SEED');
  }
  return seed;
}

export function deriveConductorSeed(seed) {
  return (assertCanonicalSeed(seed) ^ 0x9e3779b9) >>> 0;
}

export function createDeterministicRng(seed, restoredState = null) {
  const canonicalSeed = assertCanonicalSeed(seed);
  let state = canonicalSeed;
  let drawCount = 0;

  if (restoredState !== null) {
    const restored = readRestoredState(restoredState);
    if (!restored
      || !canonicalUint32(restored.state)
      || !canonicalDrawCount(restored.drawCount)
      || restored.state !== expectedState(canonicalSeed, restored.drawCount)) {
      throw deterministicError('INVALID_DETERMINISTIC_RNG_STATE');
    }
    state = restored.state;
    drawCount = restored.drawCount;
  }

  const rng = () => {
    if (drawCount >= Number.MAX_SAFE_INTEGER) {
      throw deterministicError('INVALID_DETERMINISTIC_RNG_STATE');
    }
    state = (state + MULBERRY_INCREMENT) >>> 0;
    drawCount += 1;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_DIVISOR;
  };

  Object.defineProperty(rng, 'exportState', {
    enumerable: false,
    value: () => Object.freeze({ state, drawCount }),
  });
  return rng;
}
