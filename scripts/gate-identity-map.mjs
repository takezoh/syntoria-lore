import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// Connection principals carry a synthetic issuer that no Gate token presents.
const CONNECTION_ISSUER = 'urn:syntoria:lore:connection';

const parsed = parseArguments(process.argv.slice(2));
const spec = parseSpec(JSON.parse(await readFile(parsed.file, 'utf8')));
const databaseUrl = required('IDENTITY_MAPPING_DATABASE_URL');
const action = parsed.approval
  ? `approval_${parsed.approval}`
  : parsed.deactivate
    ? 'deactivate'
    : 'activate';
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const snapshot = await readLockedBaseline(client, spec);
    const current = await readTargetBinding(client, spec);
    validateExisting(current, spec, action);
    const connection =
      action === 'activate'
        ? await readConnectionPrincipal(client, spec, snapshot, current)
        : undefined;
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
      ...(connection === undefined ? {} : { connection_principal: connection }),
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
          existing_binding:
            current === undefined
              ? null
              : {
                  active: current.active,
                  connection_principal_id: current.connection_principal_id,
                  approval_policy: current.approval_policy,
                },
          ...(connection === undefined ? {} : { connection_principal: connection }),
          baseline_sha256: fingerprint,
          next: `rerun with --apply --expected-baseline ${fingerprint}`,
        })}\n`,
      );
    } else {
      if (parsed.expectedBaseline !== fingerprint) {
        throw new Error(`Baseline changed; rerun dry-run. Current SHA-256 is ${fingerprint}`);
      }
      const result =
        action === 'activate' || action === 'deactivate'
          ? await applyBinding(client, spec, current, action, connection)
          : await applyApproval(client, current, parsed.approval);
      await client.query('COMMIT');
      process.stdout.write(
        `${JSON.stringify({ ...result, target: spec.target, baseline_sha256: fingerprint })}\n`,
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

/**
 * Activation admits the subject and gives a user principal's binding its connection principal in
 * the same transaction, so a Gate connection never acts as the person.
 */
async function applyBinding(client, mapping, current, action, connection) {
  let binding = current;
  if (action === 'activate' && current === undefined) {
    binding = (
      await client.query(
        `INSERT INTO public.external_identity_bindings
               (external_issuer, external_subject, user_id, principal_id, scope_ids, capability_ceiling)
             VALUES ($1, $2, $3, $4, $5::uuid[], $6::text[])
             RETURNING id::text, connection_principal_id::text, approval_policy`,
        [
          mapping.target.issuer,
          mapping.target.subject,
          mapping.user_id,
          mapping.principal_id,
          mapping.scope_ids,
          mapping.capability_ceiling,
        ],
      )
    ).rows[0];
  } else if (action === 'activate' && current?.active === false) {
    await client.query(
      `UPDATE public.external_identity_bindings
           SET active = true, updated_at = clock_timestamp()
           WHERE external_issuer = $1 AND external_subject = $2`,
      [mapping.target.issuer, mapping.target.subject],
    );
  } else if (action === 'deactivate' && current?.active === true) {
    await client.query(
      `UPDATE public.external_identity_bindings
           SET active = false, updated_at = clock_timestamp()
           WHERE external_issuer = $1 AND external_subject = $2`,
      [mapping.target.issuer, mapping.target.subject],
    );
  }
  if (action === 'deactivate') return { status: 'inactive' };
  const connectionPrincipalId =
    connection === undefined
      ? null
      : await applyConnectionPrincipal(client, mapping, binding, connection);
  return {
    status: 'active',
    connection_principal_id: connectionPrincipalId,
    approval_policy: binding.approval_policy,
  };
}

/** Sets how the binding's connections have their protected changes approved. */
async function applyApproval(client, binding, mode) {
  if (binding.approval_policy !== mode) {
    await client.query(
      `UPDATE public.external_identity_bindings
       SET approval_policy = $2, updated_at = clock_timestamp()
       WHERE id = $1`,
      [binding.id, mode],
    );
  }
  return { status: `approval_${mode}`, approval_policy: mode };
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
    `SELECT id::text, user_id::text, principal_id::text, scope_ids::text[], capability_ceiling,
            active, connection_principal_id::text, approval_policy
     FROM public.external_identity_bindings
     WHERE external_issuer = $1 AND external_subject = $2
     FOR UPDATE`,
    [mapping.target.issuer, mapping.target.subject],
  );
  return result.rows[0];
}

/**
 * The binding's connection principal, or one left behind for reuse, for a user principal's
 * binding. Every connection of the subject acts as it, with grants read from the user principal.
 * A binding of a non-user principal already acts as that principal and needs none.
 */
async function readConnectionPrincipal(client, mapping, snapshot, binding) {
  if (snapshot.principal.actor_kind !== 'user') return undefined;
  if (binding === undefined) return { bound: false, principal: null };
  const result = await client.query(
    `SELECT id::text, user_id::text, issuer, subject, actor_kind, active,
            acts_for_principal_id::text
     FROM public.principals
     WHERE user_id = $1
       AND (id = $2::uuid OR ($2::uuid IS NULL AND issuer = $3 AND subject = $4))
     FOR SHARE`,
    [mapping.user_id, binding.connection_principal_id, CONNECTION_ISSUER, `binding:${binding.id}`],
  );
  const principal = result.rows[0];
  if (
    principal !== undefined &&
    (principal.actor_kind !== 'client' ||
      principal.active !== true ||
      principal.acts_for_principal_id !== mapping.principal_id)
  ) {
    throw new Error('The existing connection principal does not act for the bound user principal');
  }
  return {
    bound: binding.connection_principal_id !== null,
    principal:
      principal === undefined
        ? null
        : { id: principal.id, issuer: principal.issuer, subject: principal.subject },
  };
}

async function applyConnectionPrincipal(client, mapping, binding, connection) {
  if (connection.bound) return connection.principal.id;
  const principalId =
    connection.principal?.id ??
    (
      await client.query(
        `INSERT INTO public.principals (user_id, issuer, subject, actor_kind, acts_for_principal_id)
         VALUES ($1, $2, $3, 'client', $4) RETURNING id::text`,
        [mapping.user_id, CONNECTION_ISSUER, `binding:${binding.id}`, mapping.principal_id],
      )
    ).rows[0].id;
  await client.query(
    `UPDATE public.external_identity_bindings
     SET connection_principal_id = $2, updated_at = clock_timestamp()
     WHERE id = $1`,
    [binding.id, principalId],
  );
  return principalId;
}

function validateExisting(binding, mapping, actionName) {
  if (binding === undefined) {
    if (actionName !== 'activate') throw new Error('The exact target binding does not exist');
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
    !hasExactKeys(value.target, ['issuer', 'subject'])
  ) {
    throw new Error('target must contain issuer and subject only');
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
  const usage =
    'Usage: gate-identity-map --file <mapping.json> [--deactivate | --approval auto|gate] [--apply --expected-baseline <sha256>]';
  let file;
  let apply = false;
  let deactivate = false;
  let approval;
  let expectedBaseline;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--file') file = args[++index];
    else if (arg === '--apply') apply = true;
    else if (arg === '--deactivate') deactivate = true;
    else if (arg === '--approval') approval = args[++index];
    else if (arg === '--expected-baseline') expectedBaseline = args[++index];
    else throw new Error(usage);
  }
  if (
    file === undefined ||
    (approval !== undefined && !['auto', 'gate'].includes(approval)) ||
    (approval !== undefined && deactivate) ||
    (apply && !/^[a-f0-9]{64}$/i.test(expectedBaseline ?? '')) ||
    (!apply && expectedBaseline !== undefined) ||
    (apply && args.includes('--deactivate') !== deactivate)
  ) {
    throw new Error(usage);
  }
  return { file, apply, deactivate, approval, expectedBaseline };
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
