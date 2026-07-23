export const PROTOCOL_VERSION = 1;
export const ROOT_REPLACE_PATH = '';

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
