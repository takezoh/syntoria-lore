import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const parsed = parseArguments(process.argv.slice(2));
const spec = parseSpec(JSON.parse(await readFile(parsed.file, 'utf8')));
const databaseUrl = required('IDENTITY_MAPPING_DATABASE_URL');
const action = parsed.deactivate ? 'deactivate' : 'activate';
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const snapshot = await readLockedBaseline(client, spec);
    const current = await readTargetBinding(client, spec);
    validateExisting(current, spec, action);
    const fingerprint = hashSnapshot({
      source: snapshot,
      target:
        current === undefined
          ? null
          : {
              ...current,
              scope_ids: [...current.scope_ids].sort(),
              capability_ceiling: [...current.capability_ceiling].sort(),
            },
    });

    if (!parsed.apply) {
      await client.query('ROLLBACK');
      process.stdout.write(
        `${JSON.stringify({
          status: 'dry_run',
          action,
          expected_source: spec.expected_source,
          target: spec.target,
          user_id: spec.user_id,
          principal_id: spec.principal_id,
          scope_ids: spec.scope_ids,
          capability_ceiling: spec.capability_ceiling,
          active_grants: snapshot.grants,
          existing_binding: current === undefined ? null : { active: current.active },
          baseline_sha256: fingerprint,
          next: `rerun with --apply --expected-baseline ${fingerprint}`,
        })}\n`,
      );
    } else {
      if (parsed.expectedBaseline !== fingerprint) {
        throw new Error(`Baseline changed; rerun dry-run. Current SHA-256 is ${fingerprint}`);
      }
      if (action === 'activate' && current === undefined) {
        await client.query(
          `INSERT INTO public.external_identity_bindings
             (external_issuer, external_subject, external_client_id, user_id, principal_id, scope_ids, capability_ceiling)
           VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::text[])`,
          [
            spec.target.issuer,
            spec.target.subject,
            spec.target.client_id,
            spec.user_id,
            spec.principal_id,
            spec.scope_ids,
            spec.capability_ceiling,
          ],
        );
      } else if (action === 'activate' && current?.active === false) {
        await client.query(
          `UPDATE public.external_identity_bindings
           SET active = true, updated_at = clock_timestamp()
           WHERE external_issuer = $1 AND external_subject = $2 AND external_client_id = $3`,
          [spec.target.issuer, spec.target.subject, spec.target.client_id],
        );
      } else if (action === 'deactivate' && current?.active === true) {
        await client.query(
          `UPDATE public.external_identity_bindings
           SET active = false, updated_at = clock_timestamp()
           WHERE external_issuer = $1 AND external_subject = $2 AND external_client_id = $3`,
          [spec.target.issuer, spec.target.subject, spec.target.client_id],
        );
      }

      await client.query('COMMIT');
      process.stdout.write(
        `${JSON.stringify({ status: action === 'activate' ? 'active' : 'inactive', target: spec.target, baseline_sha256: fingerprint })}\n`,
      );
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

async function readLockedBaseline(client, mapping) {
  const principalResult = await client.query(
    `SELECT id::text, user_id::text, issuer, subject, actor_kind, active
     FROM public.principals WHERE user_id = $1 AND id = $2 FOR SHARE`,
    [mapping.user_id, mapping.principal_id],
  );
  const principal = principalResult.rows[0];
  if (
    principal === undefined ||
    principal.issuer !== mapping.expected_source.issuer ||
    principal.subject !== mapping.expected_source.subject ||
    principal.active !== true
  ) {
    throw new Error('Expected active source principal was not found; no mapping was written');
  }

  const grantResult = await client.query(
    `SELECT s.id::text AS scope_id, s.auth_epoch::text AS auth_epoch,
            g.capabilities, g.expires_at
     FROM public.scopes AS s
     JOIN public.grants AS g ON g.user_id = s.user_id AND g.scope_id = s.id
     WHERE s.user_id = $1 AND g.principal_id = $2 AND s.id = ANY($3::uuid[])
       AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
     ORDER BY s.id FOR SHARE OF s, g`,
    [mapping.user_id, mapping.principal_id, mapping.scope_ids],
  );
  if (grantResult.rows.length !== mapping.scope_ids.length) {
    throw new Error('One or more requested scopes lack an active grant for the selected principal');
  }
  for (const grant of grantResult.rows) {
    if (!capabilitySet(grant.capabilities).hasAll(mapping.capability_ceiling)) {
      throw new Error(`Capability ceiling exceeds current grant for scope ${grant.scope_id}`);
    }
  }
  const requested = new Set(mapping.scope_ids);
  if (grantResult.rows.some((grant) => !requested.has(grant.scope_id))) {
    throw new Error('The local authorization snapshot contains an unexpected scope');
  }
  return {
    principal,
    grants: grantResult.rows.map((grant) => ({
      scope_id: grant.scope_id,
      auth_epoch: grant.auth_epoch,
      capabilities: [...grant.capabilities].sort(),
      expires_at: grant.expires_at === null ? null : new Date(grant.expires_at).toISOString(),
    })),
  };
}

async function readTargetBinding(client, mapping) {
  const result = await client.query(
    `SELECT user_id::text, principal_id::text, scope_ids::text[], capability_ceiling, active
     FROM public.external_identity_bindings
     WHERE external_issuer = $1 AND external_subject = $2 AND external_client_id = $3
     FOR UPDATE`,
    [mapping.target.issuer, mapping.target.subject, mapping.target.client_id],
  );
  return result.rows[0];
}

function validateExisting(binding, mapping, actionName) {
  if (binding === undefined) {
    if (actionName === 'deactivate') throw new Error('The exact target binding does not exist');
    return;
  }
  const exact =
    binding.user_id === mapping.user_id &&
    binding.principal_id === mapping.principal_id &&
    sameValues(binding.scope_ids, mapping.scope_ids) &&
    sameValues(binding.capability_ceiling, mapping.capability_ceiling);
  if (!exact)
    throw new Error('Target Gate identity is already bound to a different principal or policy');
}

function parseSpec(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Mapping file must be a JSON object');
  const expectedKeys = [
    'expected_source',
    'user_id',
    'principal_id',
    'target',
    'scope_ids',
    'capability_ceiling',
  ];
  if (!hasExactKeys(value, expectedKeys))
    throw new Error('Mapping file has missing or unexpected properties');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const text = (input, label, max) => {
    if (
      typeof input !== 'string' ||
      input.length === 0 ||
      input.length > max ||
      [...input].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      })
    ) {
      throw new Error(`${label} must be a non-empty bounded string`);
    }
    return input;
  };
  for (const key of ['user_id', 'principal_id']) {
    if (typeof value[key] !== 'string' || !uuid.test(value[key]))
      throw new Error(`${key} must be a UUID`);
  }
  if (
    !Array.isArray(value.scope_ids) ||
    value.scope_ids.length < 1 ||
    value.scope_ids.length > 100 ||
    !value.scope_ids.every((id) => typeof id === 'string' && uuid.test(id)) ||
    new Set(value.scope_ids).size !== value.scope_ids.length
  ) {
    throw new Error('scope_ids must contain 1 to 100 distinct UUIDs');
  }
  const validCapabilities = ['read', 'write', 'admin'];
  if (
    !Array.isArray(value.capability_ceiling) ||
    value.capability_ceiling.length < 1 ||
    value.capability_ceiling.length > 3 ||
    new Set(value.capability_ceiling).size !== value.capability_ceiling.length ||
    !value.capability_ceiling.every((capability) => validCapabilities.includes(capability))
  ) {
    throw new Error('capability_ceiling must contain distinct read/write/admin values');
  }
  if (
    typeof value.expected_source !== 'object' ||
    value.expected_source === null ||
    Array.isArray(value.expected_source) ||
    !hasExactKeys(value.expected_source, ['issuer', 'subject'])
  ) {
    throw new Error('expected_source must contain issuer and subject only');
  }
  if (
    typeof value.target !== 'object' ||
    value.target === null ||
    Array.isArray(value.target) ||
    !hasExactKeys(value.target, ['issuer', 'subject', 'client_id'])
  ) {
    throw new Error('target must contain issuer, subject, and client_id only');
  }
  return {
    expected_source: {
      issuer: text(value.expected_source.issuer, 'expected_source.issuer', 2048),
      subject: text(value.expected_source.subject, 'expected_source.subject', 512),
    },
    user_id: value.user_id,
    principal_id: value.principal_id,
    target: {
      issuer: text(value.target.issuer, 'target.issuer', 2048),
      subject: text(value.target.subject, 'target.subject', 512),
      client_id: text(value.target.client_id, 'target.client_id', 256),
    },
    scope_ids: [...value.scope_ids].sort(),
    capability_ceiling: [...value.capability_ceiling].sort(),
  };
}

function capabilitySet(values) {
  const capabilities = new Set(values);
  if (capabilities.has('admin')) {
    capabilities.add('read');
    capabilities.add('write');
  }
  return {
    hasAll(requested) {
      const ceiling = new Set(requested);
      if (ceiling.has('admin')) {
        ceiling.add('read');
        ceiling.add('write');
      }
      return [...ceiling].every((capability) => capabilities.has(capability));
    },
  };
}

function hashSnapshot(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactKeys(value, expected) {
  return sameValues(Object.keys(value).sort(), [...expected].sort());
}

function parseArguments(args) {
  let file;
  let apply = false;
  let deactivate = false;
  let expectedBaseline;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--file') file = args[++index];
    else if (arg === '--apply') apply = true;
    else if (arg === '--deactivate') deactivate = true;
    else if (arg === '--expected-baseline') expectedBaseline = args[++index];
    else
      throw new Error(
        'Usage: gate-identity-map --file <mapping.json> [--deactivate] [--apply --expected-baseline <sha256>]',
      );
  }
  if (
    file === undefined ||
    (apply && !/^[a-f0-9]{64}$/i.test(expectedBaseline ?? '')) ||
    (!apply && expectedBaseline !== undefined) ||
    (apply && args.includes('--deactivate') !== deactivate)
  ) {
    throw new Error(
      'Usage: gate-identity-map --file <mapping.json> [--deactivate] [--apply --expected-baseline <sha256>]',
    );
  }
  return { file, apply, deactivate, expectedBaseline };
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
