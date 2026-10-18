import { createDatabase } from './index.js';

const issuer = required('AUTH_ISSUER');
const pool = createDatabase(process.env['MIGRATION_DATABASE_URL']);

try {
  await pool.query(
    `INSERT INTO owners(id) VALUES ('11111111-1111-4111-8111-111111111111')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO scopes(owner_id, id, name)
     VALUES ('11111111-1111-4111-8111-111111111111',
       '22222222-2222-4222-8222-222222222222', 'Local test scope')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await pool.query(
    `INSERT INTO principals(id, owner_id, issuer, subject, actor_kind)
     VALUES
       ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', $1, 'demo-owner', 'owner'),
       ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', $1, 'demo-reader', 'client')
     ON CONFLICT (id) DO UPDATE SET issuer = EXCLUDED.issuer, subject = EXCLUDED.subject,
       actor_kind = EXCLUDED.actor_kind`,
    [issuer],
  );
  await pool.query(
    `INSERT INTO grants(owner_id, scope_id, principal_id, capabilities)
     VALUES
       ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
         '33333333-3333-4333-8333-333333333333', ARRAY['read', 'write', 'admin']),
       ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
         '44444444-4444-4444-8444-444444444444', ARRAY['read'])
     ON CONFLICT (owner_id, scope_id, principal_id) DO UPDATE
       SET capabilities = EXCLUDED.capabilities
       WHERE grants.capabilities IS DISTINCT FROM EXCLUDED.capabilities`,
  );
  process.stdout.write(
    JSON.stringify({
      status: 'seeded',
      owner_id: '11111111-1111-4111-8111-111111111111',
      scope_id: '22222222-2222-4222-8222-222222222222',
      principals: ['demo-owner', 'demo-reader'],
    }) + '\n',
  );
} finally {
  await pool.end();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
