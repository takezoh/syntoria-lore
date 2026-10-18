import { createDatabase } from '@memory/db';

const scopeIds = required('LOCAL_EVAL_SCOPE_IDS').split(/\s+/).filter(Boolean);
if (
  scopeIds.length < 1 ||
  scopeIds.length > 16 ||
  scopeIds.some(
    (scopeId) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scopeId),
  )
) {
  throw new Error('LOCAL_EVAL_SCOPE_IDS must contain between 1 and 16 UUIDs');
}
const pool = createDatabase(process.env['MIGRATION_DATABASE_URL'], 1);
try {
  for (const scopeId of scopeIds) {
    await pool.query(
      `INSERT INTO scopes(user_id, id, name)
       VALUES ('11111111-1111-4111-8111-111111111111', $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [scopeId, `Local evaluation ${scopeId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES
         ('11111111-1111-4111-8111-111111111111', $1,
           '33333333-3333-4333-8333-333333333333', ARRAY['read', 'write', 'admin']),
         ('11111111-1111-4111-8111-111111111111', $1,
           '44444444-4444-4444-8444-444444444444', ARRAY['read'])
       ON CONFLICT (user_id, scope_id, principal_id) DO UPDATE
         SET capabilities = EXCLUDED.capabilities
         WHERE grants.capabilities IS DISTINCT FROM EXCLUDED.capabilities`,
      [scopeId],
    );
  }
  process.stdout.write(`Created ${scopeIds.length} isolated local evaluation scopes.\n`);
} finally {
  await pool.end();
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
