export const PROTOCOL_VERSION = 1;
export const ROOT_REPLACE_PATH = '';
export const LATENT_COMMANDS = Object.freeze([
  'control.take', 'control.release', 'control.heartbeat',
  'latent.setCursor', 'latent.setMode',
  'preview.start', 'preview.stop',
]);

const LATENT_VOICES = new Set(['bass', 'pad', 'melody']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function rootReplacePatch(snapshot) {
  return deepFreeze([{
    op: 'replace',
    path: ROOT_REPLACE_PATH,
    value: structuredClone(snapshot),
  }]);
}

function exactDataObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')
      || !keys.every((key) => Object.hasOwn(value, key))) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return null;
      output[key] = descriptor.value;
    }
    structuredClone(value);
    return output;
  } catch {
    return null;
  }
}

function voice(value) {
  return typeof value === 'string' && LATENT_VOICES.has(value);
}

function token(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

export function normalizeLatentCommandPayload(name, payload) {
  if (!LATENT_COMMANDS.includes(name)) return null;
  let input;
  if (name === 'control.take') {
    const keys = Object.hasOwn(payload ?? {}, 'ttlMs') ? ['voice', 'ttlMs'] : ['voice'];
    input = exactDataObject(payload, keys);
    if (!input || !voice(input.voice)
      || (keys.length === 2 && (!Number.isSafeInteger(input.ttlMs)
        || input.ttlMs <= 0 || input.ttlMs > 10_000))) return null;
  } else if (name === 'latent.setCursor') {
    input = exactDataObject(payload, ['voice', 'leaseToken', 'eventSeq', 'cursor']);
    const cursor = exactDataObject(input?.cursor, ['x', 'y', 'pca']);
    if (!input || !voice(input.voice) || !token(input.leaseToken)
      || !Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0
      || !cursor || !Number.isFinite(cursor.x) || Math.abs(cursor.x) > 1
      || !Number.isFinite(cursor.y) || Math.abs(cursor.y) > 1
      || !Array.isArray(cursor.pca) || cursor.pca.length > 8
      || cursor.pca.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)) return null;
    input.cursor = { x: cursor.x, y: cursor.y, pca: [...cursor.pca] };
  } else if (name === 'latent.setMode') {
    input = exactDataObject(payload, ['voice', 'leaseToken', 'mode']);
    if (!input || !voice(input.voice) || !token(input.leaseToken)
      || !['xy', 'pca'].includes(input.mode)) return null;
  } else {
    input = exactDataObject(payload, ['voice', 'leaseToken']);
    if (!input || !voice(input.voice) || !token(input.leaseToken)) return null;
  }
  return deepFreeze(structuredClone(input));
}
