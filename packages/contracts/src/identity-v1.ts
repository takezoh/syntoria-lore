// Persisted v1 signatures and receipt hashes retain these provenance bytes.
// Only typed provenance fields are translated; caller context and metadata are data.
const fixedV1Values: Readonly<Record<string, string>> = {
  user: 'owner',
  user_decision: 'owner_decision',
  user_preference: 'owner_preference',
  user_assertion: 'owner_assertion',
  user_statement: 'owner_statement',
};
const fields = new Set([
  'actor_kind',
  'authority',
  'confirmation',
  'confirmation_type',
  'origin_actor_kind',
  'origin_authority',
]);
const containers = new Set([
  'operations',
  'memory',
  'replacement',
  'origin',
  'tables',
  'memories',
  'memory_versions',
  'import_provenance',
  'origin_provenance',
]);

function mapProvenance(
  value: unknown,
  values: Readonly<Record<string, string>>,
  fromKey: string,
  toKey: string,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapProvenance(item, values, fromKey, toKey));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key === fromKey ? toKey : key,
      fields.has(key) && typeof item === 'string'
        ? (values[item] ?? item)
        : containers.has(key)
          ? mapProvenance(item, values, fromKey, toKey)
          : item,
    ]),
  );
}
export function encodeIdentityProvenanceV1(value: unknown): unknown {
  return mapProvenance(value, fixedV1Values, 'origin_user_id', 'origin_owner_id');
}
export function decodeIdentityProvenanceV1(value: unknown): unknown {
  return mapProvenance(
    value,
    Object.fromEntries(Object.entries(fixedV1Values).map(([key, item]) => [item, key])),
    'origin_owner_id',
    'origin_user_id',
  );
}
