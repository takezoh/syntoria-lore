import {
  CoreError,
  getActorAuthorizationGuard,
  type ActorContext,
  type Capability,
} from '@memory/contracts';
import { uuidArray, withTransaction } from '@memory/db';
import type { Pool, PoolClient } from 'pg';

interface ScopeGrantRow {
  readonly scope_id: string;
  readonly auth_epoch: string | number;
  readonly capabilities: readonly string[];
}

export async function withAuthorizedActor<T>(
  pool: Pool,
  actor: ActorContext,
  requestedScopeIds: readonly string[],
  capability: Capability,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const scopeIds = [...new Set(requestedScopeIds)].sort();
  if (scopeIds.length === 0)
    throw new CoreError(403, 'forbidden', 'An authorized scope is required');
  for (const scopeId of scopeIds) {
    if (!actor.scopeIds.includes(scopeId) || !actor.tokenScopeIds.includes(scopeId)) {
      throw new CoreError(403, 'forbidden', 'The token does not grant every requested scope');
    }
  }
  if (!actor.capabilities.includes(capability)) {
    throw new CoreError(403, 'forbidden', `The token does not grant ${capability} access`);
  }

  const guard = getActorAuthorizationGuard(actor);
  return withTransaction(
    pool,
    async (client) => {
      await client.query("SELECT set_config('app.user_id', $1, true)", [actor.userId]);
      await client.query("SELECT set_config('app.scope_ids', $1, true)", [uuidArray(scopeIds)]);
      await client.query("SELECT set_config('app.principal_id', $1, true)", [actor.principalId]);
      const access = await client.query<ScopeGrantRow>(
        `SELECT scope_id, auth_epoch, capabilities
       FROM app.lock_actor_access($1, $2, $3, $4::uuid[])`,
        [actor.userId, actor.principalId, actor.actorKind, scopeIds],
      );
      if (access.rows.length !== scopeIds.length) {
        throw new CoreError(
          403,
          'forbidden',
          'Current database grants do not cover every requested scope',
        );
      }
      for (const row of access.rows) {
        if (!hasCapability(row.capabilities, capability)) {
          throw new CoreError(
            403,
            'forbidden',
            `Current database grants do not allow ${capability} access`,
          );
        }
        if (actor.authEpochs[row.scope_id] !== Number(row.auth_epoch)) {
          throw new CoreError(
            403,
            'stale_authorization',
            'Scope authorization changed; retry with a newly verified token',
            true,
          );
        }
      }
      return run(client);
    },
    guard === undefined ? {} : { beforeCommit: (client) => guard(client) },
  );
}

function hasCapability(values: readonly string[], required: Capability): boolean {
  return values.includes(required) || values.includes('admin');
}
