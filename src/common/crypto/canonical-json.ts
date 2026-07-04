/**
 * Deterministic JSON with recursively sorted object keys. MUST stay byte-for-
 * byte identical to the snippet SDK's `canonicalJson` (snippet/src/experiments.ts)
 * so browser signature verification matches server signing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}
