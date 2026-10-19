import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';

const url = new URL(process.env['TEST_ADMIN_URL'] ?? '');
url.pathname = '/postgres';
const root = new Pool({ connectionString: url.toString(), max: 1 });
const database = `memory_subject_${randomUUID().replaceAll('-', '')}`;
let pool: Pool | undefined;
try {
  await root.query(`CREATE DATABASE "${database}"`);
  url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.toString(), max: 1 });
  const directory = new URL('../packages/db/migrations/', import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d+_.*\.sql$/.test(name) && name < '0043_')
    .sort();
  const roles = new Set(
    (await pool.query<{ rolname: string }>('SELECT rolname FROM pg_roles')).rows.map(
      (row) => row.rolname,
    ),
  );
  for (const name of names) {
    let sql = await readFile(new URL(name, directory), 'utf8');
    if (name < '0040_')
      for (const suffix of [
        'admin',
        'app',
        'auth_lookup',
        'authority_executor',
        'purge_executor',
        'worker',
        'worker_login',
        'identity',
      ]) {
        if (roles.has(`memory_${suffix}`) && !roles.has(`thymesis_${suffix}`))
          sql = sql.replaceAll(`thymesis_${suffix}`, `memory_${suffix}`);
      }
    await pool.query("SELECT set_config('memory.role_source_prefix','thymesis',false)");
    await pool.query(sql);
  }
  const user = randomUUID(),
    principal = randomUUID(),
    scope = randomUUID();
  await pool.query('INSERT INTO users(id) VALUES ($1)', [user]);
  await pool.query(
    "INSERT INTO principals(user_id,id,issuer,subject,actor_kind) VALUES ($1,$2,'https://legacy.test','legacy','user')",
    [user, principal],
  );
  const add = async (subject: string, client: string, active: boolean, capabilities: string[]) =>
    pool!.query(
      `INSERT INTO external_identity_bindings(external_issuer,external_subject,external_client_id,user_id,principal_id,scope_ids,capability_ceiling,active)
     VALUES ('https://gate.test',$1,$2,$3,$4,$5,$6,$7)`,
      [subject, client, user, principal, [scope], capabilities, active],
    );
  await add('equivalent', 'a', true, ['read', 'write']);
  await add('equivalent', 'b', true, ['write', 'read']);
  await add('obsolete', 'a', false, ['admin']);
  await add('obsolete', 'b', true, ['read']);
  await add('inactive', 'a', false, ['admin']);
  await add('inactive', 'b', false, ['read']);
  await add('conflict', 'a', true, ['read']);
  await add('conflict', 'b', true, ['write']);
  const sql = await readFile(new URL('0043_subject_identity_admission.sql', directory), 'utf8');
  await pool.query('BEGIN');
  await assert.rejects(pool.query(sql), /Conflicting active subject authority/);
  await pool.query('ROLLBACK');
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM external_identity_bindings')).rows[0]
      .count,
    8,
  );
  await pool.query("DELETE FROM external_identity_bindings WHERE external_subject='conflict'");
  await pool.query('BEGIN');
  await pool.query(sql);
  await pool.query('COMMIT');
  const rows = (
    await pool.query(
      'SELECT external_subject, active, capability_ceiling FROM external_identity_bindings ORDER BY external_subject',
    )
  ).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.external_subject === 'inactive').active, false);
  assert.deepEqual(rows.find((row) => row.external_subject === 'obsolete').capability_ceiling, [
    'read',
  ]);
  assert.equal(rows.find((row) => row.external_subject === 'obsolete').active, true);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='external_identity_bindings' AND column_name='external_client_id'",
      )
    ).rows[0].count,
    0,
  );
  console.log(
    'Subject admission migration: equivalent consolidation, inactive isolation, conflict rollback passed',
  );
} finally {
  await pool?.end();
  await root.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await root.end();
}
