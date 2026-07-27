export const PROTOCOL_VERSION = 1;
export const ROOT_REPLACE_PATH = '';
export const LATENT_COMMANDS = Object.freeze([
  'control.take', 'control.release', 'control.heartbeat',
  'latent.setCursor', 'latent.setMode',
  'preview.start', 'preview.stop',
]);
export const MIX_COMMANDS = Object.freeze(['mix.setParam', 'mix.setMute', 'mix.setSolo']);
export const MAINTENANCE_COMMANDS = Object.freeze(['maintenance.authenticate', 'legacy.take',
  'legacy.heartbeat', 'legacy.release']);

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

export function normalizeMixCommandPayload(name, payload) {
  if (!MIX_COMMANDS.includes(name)) return null;
  if (name === 'mix.setMute' || name === 'mix.setSolo') {
    const flag = name === 'mix.setMute' ? 'muted' : 'solo';
    const input = exactDataObject(payload, ['species', flag]);
    if (!input || !['bass', 'pad', 'melody', 'texture'].includes(input.species)
        || typeof input[flag] !== 'boolean') return null;
    return deepFreeze(input);
  }
  const keys = Object.hasOwn(payload ?? {}, 'species')
    ? ['species', 'param', 'value'] : ['param', 'value'];
  const input = exactDataObject(payload, keys);
  if (!input || (keys.length === 3 && !['bass', 'pad', 'melody', 'texture'].includes(input.species))) return null;
  if (input.param === 'masterGain') {
    if (keys.length !== 2 || !Number.isFinite(input.value) || input.value < 0 || input.value > 2) return null;
  } else if (input.param === 'gain' || input.param === 'reverb') {
    const maximum = input.param === 'gain' ? 2 : 1;
    if (keys.length !== 3 || !Number.isFinite(input.value) || input.value < 0 || input.value > maximum) return null;
  } else if (input.param === 'eq') {
    const eq = exactDataObject(input.value, ['low', 'mid', 'high']);
    if (keys.length !== 3 || !eq || Object.values(eq).some((value) => (
      !Number.isFinite(value) || value < -12 || value > 12
    ))) return null;
    input.value = eq;
  } else return null;
  return deepFreeze(structuredClone(input));
}

export function normalizeAudioStatusFrame(value, { allowType = true } = {}) {
  const expected = ['statusRevision', 'runtimeOwner', 'audioOwner', 'workerReady', 'recovering',
    'degraded', 'degradedReason', 'audio'];
  if (allowType && value?.type === 'audio.status') expected.push('type', 'protocolVersion');
  const input = exactDataObject(value, expected);
  if (!input || !Number.isInteger(input.statusRevision) || input.statusRevision < 0
      || input.statusRevision > 0xffff_ffff
      || !['browser', 'server'].includes(input.runtimeOwner)
      || !['legacy', 'world'].includes(input.audioOwner)
      || typeof input.workerReady !== 'boolean' || typeof input.recovering !== 'boolean'
      || typeof input.degraded !== 'boolean'
      || !(input.degradedReason === null || typeof input.degradedReason === 'string')
      || (Object.hasOwn(input, 'type')
        && (input.type !== 'audio.status' || input.protocolVersion !== PROTOCOL_VERSION))) return null;
  if (input.audio !== null) {
    const audio = exactDataObject(input.audio, ['audioEpoch', 'manifestGeometrySha256', 'sampleRate',
      'blockFrames', 'channels', 'format', 'binaryHeaderVersion', 'headerBytes']);
    if (!audio || typeof audio.audioEpoch !== 'string' || audio.audioEpoch.length === 0
        || !/^[0-9a-f]{64}$/.test(audio.manifestGeometrySha256)
        || !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate <= 0
        || !Number.isSafeInteger(audio.blockFrames) || audio.blockFrames <= 0
        || audio.channels !== 2 || audio.format !== 'f32le'
        || audio.binaryHeaderVersion !== 1 || audio.headerBytes !== 32) return null;
    input.audio = audio;
  }
  return deepFreeze(structuredClone(input));
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

export function normalizeMaintenanceCommandPayload(name, payload) {
  if (!MAINTENANCE_COMMANDS.includes(name)) return null;
  if (name === 'maintenance.authenticate') {
    const input = exactDataObject(payload, ['credential']);
    return input && typeof input.credential === 'string' && Buffer.byteLength(input.credential) >= 32
      ? deepFreeze(input) : null;
  }
  const keys = name === 'legacy.take'
    ? ['maintenanceToken', 'decoderSessionId']
    : ['maintenanceToken', 'decoderSessionId', 'leaseToken'];
  const input = exactDataObject(payload, keys);
  if (!input || !token(input.maintenanceToken) || !token(input.decoderSessionId)
      || (keys.includes('leaseToken') && !token(input.leaseToken))) return null;
  return deepFreeze(input);
}
