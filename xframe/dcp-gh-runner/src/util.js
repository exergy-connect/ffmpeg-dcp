export function pickField(source, names) {
  if (!source || typeof source !== 'object') return '';
  for (const name of names) {
    if (source[name] != null && source[name] !== '') return source[name];
  }
  return '';
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function unwrapContextNode(value) {
  if (value && typeof value === 'object' && 's' in value) return value.s;
  return value;
}
