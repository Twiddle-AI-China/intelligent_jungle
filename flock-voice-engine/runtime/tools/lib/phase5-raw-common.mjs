import { canonicalJson } from './phase5-lease-evidence.mjs';

export const PHASE5_WINDOW_DURATION_MS = 1_800_000;

export function rawFail(code) {
  throw new Error(code);
}

export function exactObject(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

export function ownedJson(value, code) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    rawFail(code);
  }
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function ownBindingAndWindow(binding, window, code) {
  if (!exactObject(binding, [
    'runId', 'challenge', 'release', 'geometry', 'profile',
  ]) || !exactObject(window, [
    'startedAtMonotonicMs', 'endedAtMonotonicMs',
    'startedAtUnixMs', 'endedAtUnixMs',
  ])) rawFail(code);
  const ownedBinding = ownedJson(binding, code);
  const ownedWindow = ownedJson(window, code);
  const values = Object.values(ownedWindow);
  if (!values.every(Number.isSafeInteger)
      || values.some((value) => value < 0)
      || ownedWindow.endedAtMonotonicMs
        - ownedWindow.startedAtMonotonicMs !== PHASE5_WINDOW_DURATION_MS
      || ownedWindow.endedAtUnixMs
        - ownedWindow.startedAtUnixMs !== PHASE5_WINDOW_DURATION_MS) {
    rawFail(code);
  }
  return Object.freeze({
    binding: Object.freeze(ownedBinding),
    window: Object.freeze(ownedWindow),
  });
}

export function validClockPair(atMonotonicMs, atUnixMs, window) {
  return Number.isSafeInteger(atMonotonicMs)
    && Number.isSafeInteger(atUnixMs)
    && atMonotonicMs >= window.startedAtMonotonicMs
    && atMonotonicMs <= window.endedAtMonotonicMs
    && atUnixMs >= window.startedAtUnixMs
    && atUnixMs <= window.endedAtUnixMs
    && Math.abs(
      (atMonotonicMs - window.startedAtMonotonicMs)
      - (atUnixMs - window.startedAtUnixMs)
    ) <= 1;
}
