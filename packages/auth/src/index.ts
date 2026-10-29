import {
  actorKindSchema,
  bindActorAuthorizationGuard,
  CoreError,
  getActorAuthorizationGuard,
  type ActorContext,
  type Capability,
} from '@memory/contracts';
import { withTransaction, uuidArray, type PoolClient } from '@memory/db';
import type { Pool } from 'pg';
import {
  createConfirmationClient,
  createIdentityProviderVerifier,
  IdentityProviderError,
  type ExternalIdentityPrincipal,
  type IdentityProviderConfig,
} from './connection-verifier.js';

export interface AuthenticatorOptions extends IdentityProviderConfig {
  readonly pool: Pool;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface BindingRow {
  readonly user_id: string;
  readonly principal_id: string;
  readonly actor_kind: string;
  readonly scope_ids: string[];
  readonly capability_ceiling: string[];
  readonly user_principal_id: string;
}

/** The Gate identity behind an actor, used to request and verify change confirmations. */
export interface GateIdentity {
  readonly subject: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly userPrincipalId: string;
}

interface GrantRow {
  readonly scope_id: string;
  readonly auth_epoch: string;
  readonly capabilities: string[];
}

interface ActorCredential {
  readonly token: string;
  readonly principal: ExternalIdentityPrincipal;
  readonly binding: BindingRow;
}

const knownCapabilities = new Set<Capability>(['read', 'write', 'admin']);

export class Authenticator {
  /** Gate change confirmations, created and consumed with this resource's credentials. */
  readonly confirmations: ReturnType<typeof createConfirmationClient>;
  readonly audience: string;
  private readonly verifier: ReturnType<typeof createIdentityProviderVerifier>;
  private readonly credentials = new WeakMap<ActorContext, ActorCredential>();

  constructor(private readonly options: AuthenticatorOptions) {
    const { fetch, now } = options;
    const providerConfig: IdentityProviderConfig = {
      issuer: options.issuer,
      audience: options.audience,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: options.allowLoopbackHttp }),
    };
    this.verifier = createIdentityProviderVerifier(providerConfig, {
      ...(fetch === undefined ? {} : { fetch }),
      ...(now === undefined ? {} : { now }),
    });
    this.confirmations = createConfirmationClient(providerConfig, {
      ...(fetch === undefined ? {} : { fetch }),
    });
    this.audience = options.audience;
  }

  gateIdentity(actor: ActorContext): GateIdentity | undefined {
    const state = this.credentials.get(actor);
    if (state === undefined) return undefined;
    return Object.freeze({
      subject: state.principal.subject,
      connectionId: state.principal.connectionId,
      clientId: state.principal.clientId,
      userPrincipalId: state.binding.user_principal_id,
    });
  }

  /**
   * An actor for the person's user principal, used only to apply a change the person approved
   * at Gate. Its commit re-checks the requesting connection and binding like the original actor.
   */
  async userActorFor(actor: ActorContext): Promise<ActorContext> {
    const state = this.credentials.get(actor);
    if (state === undefined) {
      throw new CoreError(401, 'unauthorized', 'The Gate credential is no longer available');
    }
    const binding = state.binding;
    const boundScopeIds = sortedUnique(binding.scope_ids);
    let grants: GrantRow[];
    try {
      grants = await withTransaction(this.options.pool, async (client) => {
        await setActorDatabaseContext(
          client,
          binding.user_id,
          binding.user_principal_id,
          boundScopeIds,
        );
        const result = await client.query<GrantRow>(
          `SELECT scope_id, auth_epoch, capabilities
           FROM app.lock_actor_access($1, $2, 'user', $3::uuid[])`,
          [binding.user_id, binding.user_principal_id, boundScopeIds],
        );
        return result.rows;
      });
    } catch {
      throw new CoreError(
        503,
        'authorization_unavailable',
        'Local authorization is unavailable',
        true,
      );
    }
    if (grants.length === 0) {
      throw new CoreError(403, 'forbidden', 'The user principal has no current grant');
    }
    const ceiling = new Set(binding.capability_ceiling.filter(isCapability));
    const userActor = Object.freeze({
      userId: binding.user_id,
      principalId: binding.user_principal_id,
      actorKind: 'user' as const,
      scopeIds: Object.freeze(sortedUnique(grants.map((grant) => grant.scope_id))),
      tokenScopeIds: Object.freeze(boundScopeIds),
      capabilities: Object.freeze(effectiveCapabilities(grants, ceiling)),
      authEpochs: Object.freeze(
        Object.fromEntries(grants.map((grant) => [grant.scope_id, Number(grant.auth_epoch)])),
      ),
      clientId: state.principal.clientId,
    });
    bindActorAuthorizationGuard(userActor, (transaction) =>
      this.revalidateBeforeCommit(actor, transaction as PoolClient),
    );
    return userActor;
  }

  authenticate(authorization: string | undefined): Promise<ActorContext> {
    return this.authenticateBearer(authorization);
  }

  async authenticateBearer(authorization: string | undefined): Promise<ActorContext> {
    let principal: ExternalIdentityPrincipal;
    try {
      principal = await this.verifier.authenticate(authorization);
    } catch (error) {
      throw asCoreAuthError(error);
    }
    return this.createActor(principal, extractBearer(authorization));
  }

  async assertCurrent(actor: ActorContext): Promise<void> {
    const guard = getActorAuthorizationGuard(actor);
    if (guard === undefined) {
      throw new CoreError(401, 'unauthorized', 'The Gate credential is no longer available');
    }
    await withTransaction(this.options.pool, async () => undefined, {
      beforeCommit: (client) => guard(client),
    });
  }

  private async createActor(
    principal: ExternalIdentityPrincipal,
    token: string,
  ): Promise<ActorContext> {
    let binding: BindingRow | undefined;
    try {
      binding = await this.lookupBinding(this.options.pool, principal);
    } catch {
      throw new CoreError(
        503,
        'authorization_unavailable',
        'Local authorization is unavailable',
        true,
      );
    }
    if (binding === undefined) {
      throw new CoreError(403, 'forbidden', 'The Gate identity is not admitted');
    }
    const actorKind = actorKindSchema.safeParse(binding.actor_kind);
    if (!actorKind.success) {
      throw new CoreError(
        503,
        'authorization_unavailable',
        'The local identity binding is invalid',
        true,
      );
    }
    const boundScopeIds = sortedUnique(binding.scope_ids);
    const ceiling = new Set(binding.capability_ceiling.filter(isCapability));
    if (boundScopeIds.length === 0 || ceiling.size === 0) {
      throw new CoreError(403, 'forbidden', 'The Gate identity has no local authorization bounds');
    }
    let grants: GrantRow[];
    try {
      grants = await withTransaction(this.options.pool, async (client) => {
        await setActorDatabaseContext(client, binding.user_id, binding.principal_id, boundScopeIds);
        const result = await client.query<GrantRow>(
          `SELECT scope_id, auth_epoch, capabilities
           FROM app.lock_actor_access($1, $2, $3, $4::uuid[])`,
          [binding.user_id, binding.principal_id, actorKind.data, boundScopeIds],
        );
        return result.rows;
      });
    } catch {
      throw new CoreError(
        503,
        'authorization_unavailable',
        'Local authorization is unavailable',
        true,
      );
    }
    if (grants.length === 0) {
      throw new CoreError(403, 'forbidden', 'The admitted principal has no current grant');
    }
    const scopeIds = sortedUnique(grants.map((grant) => grant.scope_id));
    const capabilities = effectiveCapabilities(grants, ceiling);
    const actor = Object.freeze({
      userId: binding.user_id,
      principalId: binding.principal_id,
      actorKind: actorKind.data,
      scopeIds: Object.freeze(scopeIds),
      tokenScopeIds: Object.freeze(boundScopeIds),
      capabilities: Object.freeze(capabilities),
      authEpochs: Object.freeze(
        Object.fromEntries(grants.map((grant) => [grant.scope_id, Number(grant.auth_epoch)])),
      ),
      clientId: principal.clientId,
    });
    const state = Object.freeze({ token, principal, binding });
    this.credentials.set(actor, state);
    bindActorAuthorizationGuard(actor, (transaction) =>
      this.revalidateBeforeCommit(actor, transaction as PoolClient),
    );
    return actor;
  }

  private async lookupBinding(
    client: Pool | PoolClient,
    principal: ExternalIdentityPrincipal,
  ): Promise<BindingRow | undefined> {
    const result = await client.query<BindingRow>(
      `SELECT user_id, principal_id, actor_kind, scope_ids, capability_ceiling, user_principal_id
       FROM app.lock_external_identity_binding($1, $2)`,
      [principal.issuer, principal.subject],
    );
    return result.rows[0];
  }

  private async revalidateBeforeCommit(actor: ActorContext, client: PoolClient): Promise<void> {
    const state = this.credentials.get(actor);
    if (state === undefined) {
      throw new CoreError(401, 'unauthorized', 'The Gate credential is no longer available');
    }
    // Acquire the local binding/principal locks before the final online check. This keeps
    // the Gate result immediately adjacent to COMMIT even if lock acquisition had to wait.
    let binding: BindingRow | undefined;
    try {
      binding = await this.lookupBinding(client, state.principal);
    } catch {
      throw new CoreError(
        503,
        'authorization_unavailable',
        'Local authorization is unavailable',
        true,
      );
    }
    if (binding === undefined) {
      throw new CoreError(403, 'forbidden', 'The Gate identity or local binding was revoked');
    }
    if (
      binding.user_id !== actor.userId ||
      binding.principal_id !== state.binding.principal_id ||
      binding.actor_kind !== state.binding.actor_kind ||
      binding.user_principal_id !== state.binding.user_principal_id ||
      !sameStrings(sortedUnique(binding.scope_ids), sortedUnique(state.binding.scope_ids)) ||
      !sameStrings(
        sortedUnique(binding.capability_ceiling),
        sortedUnique(state.binding.capability_ceiling),
      )
    ) {
      throw new CoreError(
        403,
        'stale_authorization',
        'The local Gate binding changed; retry with a newly verified credential',
        true,
      );
    }
    let refreshed: ExternalIdentityPrincipal;
    try {
      refreshed = await this.verifier.verifyToken(state.token);
    } catch (error) {
      throw asCoreAuthError(error);
    }
    if (
      refreshed.issuer !== state.principal.issuer ||
      refreshed.subject !== state.principal.subject ||
      refreshed.connectionId !== state.principal.connectionId ||
      refreshed.clientId !== state.principal.clientId
    ) {
      throw new CoreError(401, 'unauthorized', 'The Gate connection changed during the request');
    }
  }
}

export { createIdentityProviderVerifier, IdentityProviderError } from './connection-verifier.js';
export type { ExternalIdentityPrincipal, IdentityProviderConfig } from './connection-verifier.js';

async function setActorDatabaseContext(
  client: PoolClient,
  userId: string,
  principalId: string,
  scopeIds: readonly string[],
): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  await client.query("SELECT set_config('app.scope_ids', $1, true)", [uuidArray(scopeIds)]);
  await client.query("SELECT set_config('app.principal_id', $1, true)", [principalId]);
}

function effectiveCapabilities(
  grants: readonly GrantRow[],
  ceiling: ReadonlySet<Capability>,
): Capability[] {
  const granted = new Set<Capability>();
  for (const grant of grants) {
    for (const capability of grant.capabilities.filter(isCapability)) granted.add(capability);
  }
  if (granted.has('admin')) {
    granted.add('read');
    granted.add('write');
  }
  const allowed = new Set(ceiling);
  if (allowed.has('admin')) {
    allowed.add('read');
    allowed.add('write');
  }
  return [...knownCapabilities].filter(
    (capability) => granted.has(capability) && allowed.has(capability),
  );
}

function asCoreAuthError(error: unknown): CoreError {
  if (error instanceof IdentityProviderError) {
    return error.status === 401
      ? new CoreError(401, 'unauthorized', 'The Gate credential is invalid or expired')
      : new CoreError(
          503,
          'authorization_unavailable',
          'Gate authorization is temporarily unavailable',
          true,
        );
  }
  return new CoreError(
    503,
    'authorization_unavailable',
    'Gate authorization is temporarily unavailable',
    true,
  );
}

function extractBearer(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)(?![\s\S])/i.exec(authorization ?? '');
  if (match?.[1] === undefined) {
    throw new CoreError(401, 'unauthorized', 'A single Gate Bearer token is required');
  }
  return match[1];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCapability(value: string): value is Capability {
  return knownCapabilities.has(value as Capability);
}
