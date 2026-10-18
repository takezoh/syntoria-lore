import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export async function withTemporarySuperuserAuthorization<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  const session = await client.query<{ is_superuser: boolean }>(
    `SELECT role.rolsuper AS is_superuser
     FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = session_user`,
  );
  if (session.rows[0]?.is_superuser !== true) {
    throw new Error('The current database session must be a superuser for the role-rename handoff');
  }

  const temporaryRole = `memory_migrate_${randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE ROLE "${temporaryRole}" NOLOGIN SUPERUSER`);
  let authorizationChanged = false;
  let result: T | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    await client.query(`SET SESSION AUTHORIZATION "${temporaryRole}"`);
    authorizationChanged = true;
    result = await run();
  } catch (error) {
    operationError = error;
  }

  if (authorizationChanged) {
    try {
      await client.query('RESET SESSION AUTHORIZATION');
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await client.query(`DROP ROLE "${temporaryRole}"`);
  } catch (error) {
    cleanupError ??= error;
  }

  if (cleanupError !== undefined) {
    throw new Error('Could not restore and clean up the temporary migration authorization', {
      cause: operationError ?? cleanupError,
    });
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}
