import { createDatabase, withTransaction } from '@memory/db';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCloudIdentityConfig } from './cloud-identity-config.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runCloudOwnerBootstrap(action, env = process.env) {
  if (!['ensure-owner', 'ensure-smoke', 'deactivate-smoke'].includes(action)) {
    throw new Error('The cloud owner bootstrap action is invalid');
  }
  const identity = await readCloudIdentityConfig();
  const issuer = readIssuer(env['IDENTITY_PUBLIC_URL'], env['IDENTITY_REALM'] ?? identity.realm);
  const database = createDatabase(required(env, 'MIGRATION_DATABASE_URL'), 1);
  try {
    return await withTransaction(database, async (client) => {
      if (action === 'ensure-owner') {
        const owner = readIdentity(env, 'OWNER_ID', 'OWNER_SCOPE_ID', 'OWNER_SUBJECT_ID');
        const scopeName = env['OWNER_SCOPE_NAME'] ?? 'personal';
        await ensureOwner(client, owner.ownerId, owner.scopeId, scopeName);
        await ensurePrincipal(client, {
          ownerId: owner.ownerId,
          scopeId: owner.scopeId,
          principalId: requiredUuid(env, 'OWNER_PRINCIPAL_ID'),
          issuer,
          subject: owner.subjectId,
          actorKind: 'owner',
          capabilities: ['read', 'write', 'admin'],
        });
        return 'owner-ready';
      }

      const smoke = {
        ownerId: requiredUuid(env, 'OAUTH_SMOKE_OWNER_ID'),
        scopeId: requiredUuid(env, 'OAUTH_SMOKE_SCOPE_ID'),
        subjectId: requiredUuid(
          env,
          env['OAUTH_SMOKE_SUBJECT_ID'] === undefined
            ? 'OAUTH_SMOKE_USER_ID'
            : 'OAUTH_SMOKE_SUBJECT_ID',
        ),
      };
      const smokeScopeName = env['OAUTH_SMOKE_SCOPE_NAME'] ?? 'oauth-smoke';
      const smokePrincipalId = requiredUuid(env, 'OAUTH_SMOKE_PRINCIPAL_ID');
      if (action === 'ensure-smoke') {
        const smokeCapabilities = readSmokeCapabilities(env['OAUTH_SMOKE_CAPABILITIES']);
        await ensureOwner(client, smoke.ownerId, smoke.scopeId, smokeScopeName);
        await ensurePrincipal(client, {
          ownerId: smoke.ownerId,
          scopeId: smoke.scopeId,
          principalId: smokePrincipalId,
          issuer,
          subject: smoke.subjectId,
          actorKind: 'owner',
          capabilities: smokeCapabilities,
          reactivate: true,
          reconcileCapabilities: true,
        });
        return 'smoke-ready';
      }

      await deactivateSmokePrincipal(client, {
        ownerId: smoke.ownerId,
        scopeId: smoke.scopeId,
        principalId: smokePrincipalId,
        issuer,
        subject: smoke.subjectId,
      });
      return 'smoke-disabled';
    });
  } finally {
    await database.end();
  }
}

async function ensureOwner(client, ownerId, scopeId, scopeName) {
  if (scopeName.length < 1 || scopeName.length > 200) {
    throw new Error('A configured owner scope name is invalid');
  }
  await client.query('INSERT INTO owners(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [ownerId]);
  const owner = await client.query('SELECT id FROM owners WHERE id = $1', [ownerId]);
  if (owner.rowCount !== 1)
    throw new Error('A reserved cloud owner ID conflicts with database state');

  await client.query(
    'INSERT INTO scopes(owner_id, id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [ownerId, scopeId, scopeName],
  );
  const scope = await client.query('SELECT owner_id, id, name FROM scopes WHERE id = $1', [
    scopeId,
  ]);
  const row = scope.rows[0];
  if (row?.owner_id !== ownerId || row.id !== scopeId || row.name !== scopeName) {
    throw new Error('A reserved cloud scope ID conflicts with database state');
  }
}

async function ensurePrincipal(
  client,
  {
    ownerId,
    scopeId,
    principalId,
    issuer,
    subject,
    actorKind,
    capabilities,
    reactivate = false,
    reconcileCapabilities = false,
  },
) {
  await client.query(
    `INSERT INTO principals(id, owner_id, issuer, subject, actor_kind)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [principalId, ownerId, issuer, subject, actorKind],
  );
  const principal = await client.query(
    `SELECT id, owner_id, issuer, subject, actor_kind, active
     FROM principals WHERE id = $1`,
    [principalId],
  );
  const row = principal.rows[0];
  if (
    row?.owner_id !== ownerId ||
    row.issuer !== issuer ||
    row.subject !== subject ||
    row.actor_kind !== actorKind
  ) {
    throw new Error('A reserved cloud principal ID conflicts with database state');
  }
  if (row.active !== true && !reactivate) {
    throw new Error('The reserved cloud owner principal is inactive');
  }
  if (reactivate && row.active !== true) {
    await client.query('UPDATE principals SET active = true WHERE id = $1', [principalId]);
  }

  if (reconcileCapabilities) {
    const grants = await client.query(
      'SELECT scope_id FROM grants WHERE owner_id = $1 AND principal_id = $2 FOR UPDATE',
      [ownerId, principalId],
    );
    if (grants.rows.some((grant) => grant.scope_id !== scopeId)) {
      throw new Error('The reserved smoke principal has an unexpected grant');
    }
  }

  await client.query(
    `INSERT INTO grants(owner_id, scope_id, principal_id, capabilities)
     VALUES ($1, $2, $3, $4::text[]) ON CONFLICT (owner_id, scope_id, principal_id) DO NOTHING`,
    [ownerId, scopeId, principalId, capabilities],
  );
  let grant = await client.query(
    `SELECT capabilities FROM grants
     WHERE owner_id = $1 AND scope_id = $2 AND principal_id = $3 FOR UPDATE`,
    [ownerId, scopeId, principalId],
  );
  let storedCapabilities = grant.rows[0]?.capabilities;
  const capabilitiesMatch =
    Array.isArray(storedCapabilities) &&
    [...storedCapabilities].sort().join(',') === [...capabilities].sort().join(',');
  if (!capabilitiesMatch && reconcileCapabilities) {
    await client.query(
      `UPDATE grants SET capabilities = $4::text[]
       WHERE owner_id = $1 AND scope_id = $2 AND principal_id = $3`,
      [ownerId, scopeId, principalId, capabilities],
    );
    grant = await client.query(
      `SELECT capabilities FROM grants
       WHERE owner_id = $1 AND scope_id = $2 AND principal_id = $3 FOR UPDATE`,
      [ownerId, scopeId, principalId],
    );
    storedCapabilities = grant.rows[0]?.capabilities;
  }
  if (
    !Array.isArray(storedCapabilities) ||
    [...storedCapabilities].sort().join(',') !== [...capabilities].sort().join(',')
  ) {
    throw new Error('A reserved cloud principal grant conflicts with database state');
  }
}

function readSmokeCapabilities(value) {
  const capabilities = (value ?? 'read').split(',').map((capability) => capability.trim());
  const allowed = new Set(['read', 'write', 'admin']);
  if (
    capabilities.length === 0 ||
    capabilities.some((capability) => !allowed.has(capability)) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw new Error('OAUTH_SMOKE_CAPABILITIES must be a unique subset of read,write,admin');
  }
  return capabilities.sort();
}

async function deactivateSmokePrincipal(
  client,
  { ownerId, scopeId, principalId, issuer, subject },
) {
  const result = await client.query(
    `SELECT id, owner_id, issuer, subject, actor_kind
     FROM principals WHERE id = $1 FOR UPDATE`,
    [principalId],
  );
  const row = result.rows[0];
  if (row === undefined) return;
  if (
    row.owner_id !== ownerId ||
    row.issuer !== issuer ||
    row.subject !== subject ||
    row.actor_kind !== 'owner'
  ) {
    throw new Error('The reserved smoke principal ID conflicts with database state');
  }
  const grants = await client.query(
    'SELECT scope_id FROM grants WHERE owner_id = $1 AND principal_id = $2 FOR UPDATE',
    [ownerId, principalId],
  );
  if (grants.rows.some((grant) => grant.scope_id !== scopeId)) {
    throw new Error('The reserved smoke principal has an unexpected grant');
  }
  await client.query(
    'DELETE FROM grants WHERE owner_id = $1 AND scope_id = $2 AND principal_id = $3',
    [ownerId, scopeId, principalId],
  );
  await client.query('UPDATE principals SET active = false WHERE id = $1', [principalId]);
}

function readIdentity(env, ownerName, scopeName, subjectName) {
  return {
    ownerId: requiredUuid(env, ownerName),
    scopeId: requiredUuid(env, scopeName),
    subjectId: requiredUuid(env, subjectName),
  };
}

function requiredUuid(env, name) {
  const value = required(env, name);
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

function readIssuer(value, realm) {
  if (value === undefined || value.length === 0) throw new Error('IDENTITY_PUBLIC_URL is required');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('IDENTITY_PUBLIC_URL must be an HTTPS origin');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(realm) || realm.toLowerCase() === 'master') {
    throw new Error('IDENTITY_REALM must be one safe application realm segment');
  }
  return `${url.origin}/realms/${realm}`;
}

function required(env, name) {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const action = process.env['CLOUD_OWNER_BOOTSTRAP_ACTION'] ?? 'ensure-owner';
  try {
    const result = await runCloudOwnerBootstrap(action);
    process.stdout.write(`${JSON.stringify({ status: result })}\n`);
  } catch {
    process.stderr.write('Cloud owner bootstrap failed; inspect the migration job logs.\n');
    process.exitCode = 1;
  }
}
