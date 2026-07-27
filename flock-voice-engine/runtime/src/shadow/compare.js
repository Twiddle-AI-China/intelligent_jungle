import {
  canonicalizeShadowValue,
  wildcardShadowPath,
} from './canonicalize.js';

export const SHADOW_TOLERANCES = Object.freeze({
  '$.simTime': 1e-12,
  '$.phase': 1e-12,
  '$.daylight': 1e-12,
  '$.meanEnergy': 1e-12,
  '$.birds[*].energy': 1e-12,
  '$.birds[*].dwellTime': 1e-12,
  '$.birds[*].dwellBeatTime': 1e-12,
  '$.birds[*].flightTime': 1e-12,
  '$.birds[*].plannedDwell': 1e-12,
  '$.birds[*].plannedFlight': 1e-12,
  '$.birds[*].pos.x': 1e-12,
  '$.birds[*].pos.y': 1e-12,
  '$.trees[*].meanEnergy': 1e-12,
  '$.trees[*].birds[*].energy': 1e-12,
  '$.trees[*].birds[*].dwellTime': 1e-12,
  '$.trees[*].birds[*].dwellBeatTime': 1e-12,
  '$.trees[*].birds[*].flightTime': 1e-12,
  '$.trees[*].birds[*].plannedDwell': 1e-12,
  '$.trees[*].birds[*].plannedFlight': 1e-12,
  '$.trees[*].birds[*].pos.x': 1e-12,
  '$.trees[*].birds[*].pos.y': 1e-12,
});

function difference(path, expected, actual, context, tolerance = null) {
  const arrayIndex = path.match(/\[(\d+)\](?:\.|$)/);
  return Object.freeze({
    kind: context.kind,
    tick: context.tick ?? null,
    operationIndex: context.operationIndex ?? null,
    eventIndex: context.eventIndex ?? (
      context.kind === 'events' && arrayIndex ? Number(arrayIndex[1]) : null
    ),
    path,
    expected: canonicalizeShadowValue(expected),
    actual: canonicalizeShadowValue(actual),
    tolerance,
    recentExpectedEvents: canonicalizeShadowValue(context.recentExpectedEvents ?? []),
    recentActualEvents: canonicalizeShadowValue(context.recentActualEvents ?? []),
    expectedRng: canonicalizeShadowValue(context.expectedRng ?? null),
    actualRng: canonicalizeShadowValue(context.actualRng ?? null),
  });
}

function compare(expected, actual, path, context) {
  if (typeof expected === 'number' || typeof actual === 'number') {
    if (typeof expected !== 'number' || typeof actual !== 'number') {
      return difference(path, expected, actual, context);
    }
    if (Number.isNaN(expected) || Number.isNaN(actual)) {
      return difference(path, expected, actual, context);
    }
    if (Object.is(expected, actual)) return null;
    const tolerance = context.kind === 'snapshot'
      ? SHADOW_TOLERANCES[wildcardShadowPath(path)]
      : undefined;
    if (tolerance !== undefined
      && Number.isFinite(expected)
      && Number.isFinite(actual)
      && Math.abs(expected - actual) <= tolerance) return null;
    return difference(path, expected, actual, context, tolerance ?? null);
  }
  if (Object.is(expected, actual)) return null;
  if (expected === null || actual === null
    || typeof expected !== 'object' || typeof actual !== 'object') {
    return difference(path, expected, actual, context);
  }
  const expectedArray = Array.isArray(expected);
  const actualArray = Array.isArray(actual);
  if (expectedArray !== actualArray) return difference(path, expected, actual, context);
  if (expectedArray) {
    if (expected.length !== actual.length) return difference(`${path}.length`, expected.length, actual.length, context);
    for (let index = 0; index < expected.length; index += 1) {
      const found = compare(expected[index], actual[index], `${path}[${index}]`, context);
      if (found !== null) return found;
    }
    return null;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const allKeys = [...new Set([...expectedKeys, ...actualKeys])].sort();
  for (const key of allKeys) {
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) {
      return difference(`${path}.${key}`, expected[key], actual[key], context);
    }
  }
  for (const key of expectedKeys) {
    const found = compare(expected[key], actual[key], `${path}.${key}`, context);
    if (found !== null) return found;
  }
  return null;
}

export function compareShadowValue(expected, actual, context) {
  if (!context || typeof context.kind !== 'string') {
    throw new Error('SHADOW_COMPARISON_CONTEXT_REQUIRED');
  }
  return compare(expected, actual, '$', context);
}
