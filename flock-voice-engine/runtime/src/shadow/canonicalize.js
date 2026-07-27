export function canonicalizeShadowValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeShadowValue);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeShadowValue(value[key])]),
  );
}

export function wildcardShadowPath(path) {
  return path.replace(/\[\d+\]/g, '[*]');
}
