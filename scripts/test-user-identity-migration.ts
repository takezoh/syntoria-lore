import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrate } from '@memory/db';
import { CursorCodec } from '@memory/domain';

const input = process.env['TEST_ADMIN_URL'];
if (!input) throw new Error('TEST_ADMIN_URL is required');
const database = `memory_user_migration_${randomUUID().replaceAll('-', '')}`;
const rootUrl = new URL(input);
rootUrl.pathname = '/postgres';
const root = new Pool({ connectionString: rootUrl.toString(), max: 1 });
const appRole = `memory_user_test_${randomUUID().replaceAll('-', '')}`;
let appRoleCreated = false;
let admin: Pool | undefined;
let app: Pool | undefined;
try {
  await root.query(`CREATE DATABASE "${database}"`);
  const target = new URL(input);
  target.pathname = `/${database}`;
  admin = new Pool({ connectionString: target.toString(), max: 1 });
  const directory = new URL('../packages/db/migrations/', import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d+_.*\.sql$/.test(name) && name < '0041_')
    .sort();
  const suffixes = [
    'admin',
    'app',
    'auth_lookup',
    'authority_executor',
    'purge_executor',
    'worker',
    'worker_login',
    'identity',
  ];
  const roles = await admin.query<{ rolname: string }>('SELECT rolname FROM pg_roles');
  const existing = new Set(roles.rows.map((row) => row.rolname));
  for (const name of names) {
    const source = await readFile(new URL(name, directory), 'utf8');
    let sql = source;
    if (name < '0040_')
      for (const suffix of suffixes) {
        if (existing.has(`memory_${suffix}`) && !existing.has(`thymesis_${suffix}`))
          sql = sql.replaceAll(`thymesis_${suffix}`, `memory_${suffix}`);
      }
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('memory.role_source_prefix','thymesis',true)");
      await admin.query(sql);
      await admin.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [
        name,
        createHash('sha256').update(source).digest('hex'),
      ]);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }
  const user = randomUUID(),
    otherUser = randomUUID(),
    scope = randomUUID(),
    principal = randomUUID();
  await admin.query('INSERT INTO owners(id) VALUES ($1),($2)', [user, otherUser]);
  await admin.query('INSERT INTO scopes(owner_id,id,name) VALUES ($1,$2,$3)', [
    user,
    scope,
    'migration fixture',
  ]);
  await admin.query(
    "INSERT INTO principals(owner_id,id,issuer,subject,actor_kind) VALUES ($1,$2,'https://fixture.invalid/','preserved-subject','owner')",
    [user, principal],
  );
  await admin.query(
    "INSERT INTO grants(owner_id,scope_id,principal_id,capabilities) VALUES ($1,$2,$3,ARRAY['read','write','admin'])",
    [user, scope, principal],
  );
  const context = {
    actor_kind: 'owner',
    authority: 'owner_assertion',
    nested: { owner_id: user, confirmation: 'owner_statement' },
    context: { actor_kind: 'user' },
  };
  const memory = randomUUID();
  await admin.query(
    "INSERT INTO memories(owner_id,scope_id,id,kind,statement,context,actor_kind,authority,epistemic_status,lifecycle,created_by,import_provenance) VALUES ($1,$2,$3,'fact','owner wording remains verbatim',$4,'owner','owner_assertion','asserted','active',$5,$6)",
    [
      user,
      scope,
      memory,
      context,
      principal,
      { origin_owner_id: user, origin_actor_kind: 'owner', origin_authority: 'owner_assertion' },
    ],
  );
  const receipt = { committed: true, preserved: randomUUID() };
  const change = randomUUID(),
    key = randomUUID(),
    hash = 'ab'.repeat(32);
  await admin.query(
    "INSERT INTO changesets(owner_id,scope_id,id,principal_id,request_id,operation_count,status,response,committed_at) VALUES ($1,$2,$3,$4,$5,1,'committed',$6,clock_timestamp())",
    [user, scope, change, principal, randomUUID(), receipt],
  );
  await admin.query(
    'INSERT INTO idempotency_keys(owner_id,scope_id,principal_id,idempotency_key,payload_hash,response,change_set_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [user, scope, principal, key, hash, receipt, change],
  );
  const epoch = await admin.query<{ auth_epoch: string }>(
    'SELECT auth_epoch FROM scopes WHERE id=$1',
    [scope],
  );
  const codec = new CursorCodec('fixture', new Map([['fixture', Buffer.alloc(32, 7)]]));
  const cursor = codec.encode({
    user,
    principal,
    scopes: [scope],
    offsets: { [scope]: '0' },
    auth_epochs: { [scope]: Number(epoch.rows[0]!.auth_epoch) },
    compartments: { epoch: 0, ids: [] },
  });
  assert.equal(JSON.parse(Buffer.from(cursor.split('.')[0]!, 'base64url').toString()).owner, user);
  const oid = await admin.query<{ oid: number }>("SELECT 'owners'::regclass::oid AS oid");
  await admin.query(
    "CREATE VIEW migration_dependency_guard AS SELECT * FROM app.resolve_principal('https://fixture.invalid/','preserved-subject')",
  );
  await assert.rejects(migrate(admin, { roleSourcePrefix: 'thymesis' }), /Unexpected dependency/);
  assert.equal(
    (await admin.query("SELECT 'owners'::regclass::oid AS oid")).rows[0]!.oid,
    oid.rows[0]!.oid,
  );
  await admin.query('DROP VIEW migration_dependency_guard');
  const renameSource = await readFile(new URL('0041_user_identity.sql', directory), 'utf8');
  await admin.query('BEGIN');
  try {
    await admin.query("SELECT set_config('memory.role_source_prefix','thymesis',true)");
    await admin.query(renameSource);
    await admin.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [
      '0041_user_identity.sql',
      createHash('sha256').update(renameSource).digest('hex'),
    ]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  const renamed = await admin.query<{ oid: number }>("SELECT 'users'::regclass::oid AS oid");
  assert.equal(renamed.rows[0]!.oid, oid.rows[0]!.oid);
  const preserved = await admin.query(
    'SELECT context,statement,actor_kind,authority,import_provenance FROM memories WHERE id=$1',
    [memory],
  );
  assert.deepEqual(preserved.rows, [
    {
      context,
      statement: 'owner wording remains verbatim',
      actor_kind: 'user',
      authority: 'user_assertion',
      import_provenance: {
        origin_user_id: user,
        origin_actor_kind: 'user',
        origin_authority: 'user_assertion',
      },
    },
  ]);
  assert.equal(
    (await admin.query('SELECT proposal FROM changesets WHERE id=$1', [change])).rows[0]!.proposal,
    null,
  );
  const saved = await admin.query(
    'SELECT payload_hash,response FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2',
    [user, key],
  );
  assert.deepEqual(saved.rows, [{ payload_hash: hash, response: receipt }]);
  assert.equal(codec.decode(cursor, { user, principal, scopes: [scope] }).user, user);
  const resolved = await admin.query(
    'SELECT user_id,principal_id FROM app.resolve_principal($1,$2)',
    ['https://fixture.invalid/', 'preserved-subject'],
  );
  assert.deepEqual(resolved.rows, [{ user_id: user, principal_id: principal }]);
  const beforeExternalBinding = await admin.query(
    `SELECT u.id AS user_id, s.id AS scope_id, s.auth_epoch, p.id AS principal_id,
            p.issuer, p.subject, p.actor_kind, p.active, g.capabilities,
            m.id AS memory_id, m.statement, m.authority,
            i.idempotency_key, i.payload_hash, i.response
     FROM users u JOIN scopes s ON s.user_id=u.id
     JOIN principals p ON p.user_id=u.id
     JOIN grants g ON g.user_id=u.id AND g.scope_id=s.id AND g.principal_id=p.id
     JOIN memories m ON m.user_id=u.id AND m.scope_id=s.id
     JOIN idempotency_keys i ON i.user_id=u.id AND i.scope_id=s.id AND i.principal_id=p.id
     WHERE u.id=$1 AND s.id=$2 AND p.id=$3 AND m.id=$4 AND i.idempotency_key=$5`,
    [user, scope, principal, memory, key],
  );
  assert.equal(beforeExternalBinding.rowCount, 1);
  await migrate(admin, { roleSourcePrefix: 'thymesis' });
  await migrate(admin, { roleSourcePrefix: 'thymesis' });
  assert.deepEqual(
    (
      await admin.query(
        `SELECT u.id AS user_id, s.id AS scope_id, s.auth_epoch, p.id AS principal_id,
                p.issuer, p.subject, p.actor_kind, p.active, g.capabilities,
                m.id AS memory_id, m.statement, m.authority,
                i.idempotency_key, i.payload_hash, i.response
         FROM users u JOIN scopes s ON s.user_id=u.id
         JOIN principals p ON p.user_id=u.id
         JOIN grants g ON g.user_id=u.id AND g.scope_id=s.id AND g.principal_id=p.id
         JOIN memories m ON m.user_id=u.id AND m.scope_id=s.id
         JOIN idempotency_keys i ON i.user_id=u.id AND i.scope_id=s.id AND i.principal_id=p.id
         WHERE u.id=$1 AND s.id=$2 AND p.id=$3 AND m.id=$4 AND i.idempotency_key=$5`,
        [user, scope, principal, memory, key],
      )
    ).rows,
    beforeExternalBinding.rows,
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0]!.count,
    (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).length,
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS count FROM external_identity_bindings')).rows[0]!
      .count,
    0,
  );
  const password = 'synthetic-user-migration-app-only';
  await admin.query(
    `CREATE ROLE "${appRole}" LOGIN PASSWORD 'synthetic-user-migration-app-only' NOSUPERUSER NOBYPASSRLS INHERIT`,
  );
  appRoleCreated = true;
  await admin.query(`GRANT memory_app TO "${appRole}"`);
  target.username = appRole;
  target.password = password;
  app = new Pool({ connectionString: target.toString(), max: 1 });
  assert.equal((await app.query('SELECT * FROM principals')).rowCount, 0);
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id',$1,true)", [user]);
    await client.query("SELECT set_config('app.scope_ids',$1,true)", [`{${scope}}`]);
    // Rows that predate compartments are Unclassified: visible only within that compartment.
    assert.equal(
      (await client.query('SELECT * FROM idempotency_keys WHERE user_id=$1', [user])).rowCount,
      0,
    );
    await client.query("SELECT set_config('app.compartment_ids',$1,true)", [
      '{00000000-0000-4000-8000-000000000001}',
    ]);
    assert.equal(
      (await client.query('SELECT * FROM idempotency_keys WHERE user_id=$1', [user])).rowCount,
      1,
    );
    await client.query("SELECT set_config('app.user_id',$1,true)", [otherUser]);
    assert.equal(
      (await client.query('SELECT * FROM idempotency_keys WHERE user_id=$1', [user])).rowCount,
      0,
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  console.log(
    'Identity migrations: existing user/principal/scope IDs, auth epoch, grants, memory, receipt/hash, v1 cursor, table OID and RLS preserved; current migrations and reapply passed.',
  );
} finally {
  await app?.end();
  await admin?.end();
  await root.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  if (appRoleCreated) await root.query(`DROP ROLE "${appRole}"`);
  await root.end();
}
