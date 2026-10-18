import type { Pool, PoolClient } from 'pg';

export interface PrincipalIssuerCutoverOptions {
  readonly sourceIssuer: string;
  readonly targetIssuer: string;
  readonly ownerPrincipalId: string;
  readonly ownerId: string;
  readonly ownerSubjectId: string;
  readonly databaseAdminRole?: string;
}

export interface PrincipalIssuerCutoverResult {
  readonly status: 'migrated' | 'already-current';
  readonly principalCount: number;
  readonly ownerPrincipalId: string;
  readonly principalIdsPreserved: true;
  readonly grantsPreserved: true;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function cutoverPrincipalIssuer(
  database: Pool,
  options: PrincipalIssuerCutoverOptions,
): Promise<PrincipalIssuerCutoverResult> {
  const sourceIssuer = validateIssuer(options.sourceIssuer, 'sourceIssuer');
  const targetIssuer = validateIssuer(options.targetIssuer, 'targetIssuer');
  const ownerPrincipalId = validateUuid(options.ownerPrincipalId, 'ownerPrincipalId');
  const ownerId = validateUuid(options.ownerId, 'ownerId');
  const ownerSubjectId = validateUuid(options.ownerSubjectId, 'ownerSubjectId');
  if (sourceIssuer === targetIssuer)
    throw new Error('The source and target identity issuers must differ');

  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await migrateIssuerInTransaction(client, {
      sourceIssuer,
      targetIssuer,
      ownerPrincipalId,
      ownerId,
      ownerSubjectId,
      ...(options.databaseAdminRole === undefined
        ? {}
        : { databaseAdminRole: validateRoleName(options.databaseAdminRole) }),
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrateIssuerInTransaction(
  client: PoolClient,
  options: PrincipalIssuerCutoverOptions,
): Promise<PrincipalIssuerCutoverResult> {
  const { sourceIssuer, targetIssuer, ownerPrincipalId, ownerId, ownerSubjectId } = options;
  if (options.databaseAdminRole !== undefined) {
    await client.query(`SET LOCAL ROLE "${options.databaseAdminRole}"`);
  }
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['701023243']);
  const tableState = await client.query<{
    owner: string;
    current_role: string;
    current_is_superuser: boolean;
    current_bypasses_rls: boolean;
  }>(
    `SELECT pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
            current_user AS current_role,
            (SELECT role.rolsuper FROM pg_catalog.pg_roles AS role
             WHERE role.rolname = current_user) AS current_is_superuser,
            (SELECT role.rolbypassrls FROM pg_catalog.pg_roles AS role
             WHERE role.rolname = current_user) AS current_bypasses_rls
     FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'public.principals'::regclass`,
  );
  const table = tableState.rows[0];
  if (table === undefined || (table.owner !== table.current_role && !table.current_is_superuser)) {
    throw new Error('The configured database role must own the principals table');
  }
  if (!table.current_is_superuser && !table.current_bypasses_rls) {
    throw new Error('The configured database role must bypass RLS for issuer cutover');
  }
  await client.query('LOCK TABLE public.principals IN SHARE ROW EXCLUSIVE MODE');
  return migrateIssuerRows(client, {
    sourceIssuer,
    targetIssuer,
    ownerPrincipalId,
    ownerId,
    ownerSubjectId,
    ...(options.databaseAdminRole === undefined
      ? {}
      : { databaseAdminRole: options.databaseAdminRole }),
  });
}

async function migrateIssuerRows(
  client: PoolClient,
  options: PrincipalIssuerCutoverOptions,
): Promise<PrincipalIssuerCutoverResult> {
  const { sourceIssuer, targetIssuer, ownerPrincipalId, ownerId, ownerSubjectId } = options;

  const ownerResult = await client.query<{
    id: string;
    owner_id: string;
    issuer: string;
    subject: string;
    actor_kind: string;
    active: boolean;
  }>(
    `SELECT id, owner_id, issuer, subject, actor_kind, active
     FROM public.principals WHERE id = $1 FOR UPDATE`,
    [ownerPrincipalId],
  );
  const owner = ownerResult.rows[0];
  const ownerIssuerMatches = owner?.issuer === sourceIssuer || owner?.issuer === targetIssuer;
  if (
    owner === undefined ||
    owner.owner_id !== ownerId ||
    owner.subject !== ownerSubjectId ||
    owner.actor_kind !== 'owner' ||
    owner.active !== true ||
    !ownerIssuerMatches
  ) {
    throw new Error(
      'The configured owner principal does not match the identity migration baseline',
    );
  }

  const sourceCountResult = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM public.principals WHERE issuer = $1',
    [sourceIssuer],
  );
  const sourceCount = sourceCountResult.rows[0]?.count ?? 0;
  if (sourceCount === 0) {
    if (owner.issuer !== targetIssuer) {
      throw new Error(
        'The source issuer has no principals but the expected owner is not at the target issuer',
      );
    }
    const targetCount = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM public.principals WHERE issuer = $1',
      [targetIssuer],
    );
    return {
      status: 'already-current',
      principalCount: targetCount.rows[0]?.count ?? 0,
      ownerPrincipalId,
      principalIdsPreserved: true,
      grantsPreserved: true,
    };
  }
  if (owner.issuer !== sourceIssuer) {
    throw new Error(
      'The issuer migration is partially applied; source principals remain after owner migration',
    );
  }

  const targetConflict = await client.query(
    `SELECT source.id AS source_id, target.id AS target_id
     FROM public.principals AS source
     JOIN public.principals AS target
       ON target.issuer = $2 AND target.subject = source.subject
     WHERE source.issuer = $1
     LIMIT 1`,
    [sourceIssuer, targetIssuer],
  );
  if (targetConflict.rowCount !== 0) {
    throw new Error('A principal subject already exists at the target issuer');
  }

  await client.query(
    `
    CREATE TEMP TABLE identity_issuer_cutover_snapshot ON COMMIT DROP AS
    SELECT p.id,
           to_jsonb(p) - 'issuer' AS principal_identity,
           COALESCE(
             jsonb_agg(to_jsonb(g) ORDER BY g.owner_id, g.scope_id, g.principal_id)
               FILTER (WHERE g.principal_id IS NOT NULL),
             '[]'::jsonb
           ) AS grants
    FROM public.principals AS p
    LEFT JOIN public.grants AS g ON g.owner_id = p.owner_id AND g.principal_id = p.id
    WHERE p.issuer = $1
    GROUP BY p.id
  `,
    [sourceIssuer],
  );
  const update = await client.query(
    'UPDATE public.principals SET issuer = $2 WHERE issuer = $1 RETURNING id',
    [sourceIssuer, targetIssuer],
  );
  if (update.rowCount !== sourceCount) {
    throw new Error('The number of updated principals changed during issuer cutover');
  }

  const verification = await client.query<{ count: number; mismatches: number }>(`
    SELECT count(*)::int AS count,
           count(*) FILTER (
             WHERE snapshot.principal_identity IS DISTINCT FROM to_jsonb(principal) - 'issuer'
                OR snapshot.grants IS DISTINCT FROM COALESCE(
                  (SELECT jsonb_agg(to_jsonb(grant_row)
                                   ORDER BY grant_row.owner_id, grant_row.scope_id, grant_row.principal_id)
                   FROM public.grants AS grant_row
                   WHERE grant_row.owner_id = principal.owner_id
                     AND grant_row.principal_id = principal.id),
                  '[]'::jsonb
                )
           )::int AS mismatches
    FROM identity_issuer_cutover_snapshot AS snapshot
    JOIN public.principals AS principal ON principal.id = snapshot.id
  `);
  const verified = verification.rows[0];
  if (verified?.count !== sourceCount || verified.mismatches !== 0) {
    throw new Error('Principal identity or grants changed during issuer cutover');
  }
  return {
    status: 'migrated',
    principalCount: sourceCount,
    ownerPrincipalId,
    principalIdsPreserved: true,
    grantsPreserved: true,
  };
}

function validateIssuer(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid identity realm issuer`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    segments.length !== 2 ||
    segments[0] !== 'realms' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segments[1] ?? '')
  ) {
    throw new Error(`${name} must be an exact HTTPS realm issuer`);
  }
  return `${url.origin}${url.pathname}`;
}

function validateUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

function validateRoleName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error('databaseAdminRole must be a valid PostgreSQL role name');
  }
  return value;
}
