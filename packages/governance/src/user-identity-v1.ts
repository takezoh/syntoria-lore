import { encodeIdentityProvenanceV1, decodeIdentityProvenanceV1 } from '@memory/contracts';

// Payload format v1 retains its original identity keys. This is a fixed codec,
// not an alternate public API field or an inferred compatibility fallback.
function renameBundleIdentityV1(value: unknown, from: string, to: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const bundle = value as Record<string, unknown>;
  const rename = (row: unknown): unknown => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
    return Object.fromEntries(
      Object.entries(row).map(([key, item]) => [key === from ? to : key, item]),
    );
  };
  const tables = bundle['tables'];
  return {
    ...bundle,
    origin: rename(bundle['origin']),
    tables:
      tables !== null && typeof tables === 'object' && !Array.isArray(tables)
        ? Object.fromEntries(
            Object.entries(tables).map(([key, rows]) => [
              key,
              Array.isArray(rows) ? rows.map(rename) : rows,
            ]),
          )
        : tables,
  };
}
export function encodePortableBundleV1(value: unknown): unknown {
  return encodeIdentityProvenanceV1(renameBundleIdentityV1(value, 'user_id', 'owner_id'));
}
export function decodePortableBundleV1(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const origin = (value as Record<string, unknown>)['origin'];
  if (
    origin === null ||
    typeof origin !== 'object' ||
    !('owner_id' in origin) ||
    'user_id' in origin
  )
    return undefined;
  return decodeIdentityProvenanceV1(renameBundleIdentityV1(value, 'owner_id', 'user_id'));
}
