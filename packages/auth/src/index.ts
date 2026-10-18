import { CoreError, uuidSchema, type ActorContext, type Capability } from '@memory/contracts';
import { withTransaction, uuidArray } from '@memory/db';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from 'pg';

const tokenScopesClaim = 'scope_ids';
const memoryCapabilityScopes = new Set(['memory:read', 'memory:write', 'memory:admin']);
const memorySupportScopes = new Set([
  'memory:resource:api',
  'memory:resource:mcp:read',
  'memory:resource:mcp:write',
  'memory:scope_ids',
]);

export interface AuthenticatorOptions {
  readonly pool: Pool;
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly allowedAlgorithms?: readonly ('RS256' | 'ES256' | 'EdDSA')[];
}

interface PrincipalRow {
  user_id: string;
  principal_id: string;
  actor_kind: ActorContext['actorKind'];
}

interface GrantRow {
  scope_id: string;
  auth_epoch: string;
  capabilities: string[];
}

export class Authenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly algorithms: readonly string[];

  constructor(private readonly options: AuthenticatorOptions) {
    const jwksUrl = new URL(options.jwksUrl);
    const issuerUrl = new URL(options.issuer);
    const explicitDockerIssuerFixture =
      process.env['LOCAL_AUTH_FIXTURE'] === '1' &&
      jwksUrl.protocol === 'http:' &&
      jwksUrl.hostname === 'issuer' &&
      issuerUrl.href === 'http://localhost:19090/';
    if (
      jwksUrl.protocol !== 'https:' &&
      !isLocalHost(jwksUrl.hostname) &&
      !explicitDockerIssuerFixture
    ) {
      throw new Error('AUTH_JWKS_URL must use HTTPS outside localhost');
    }
    this.jwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 5_000, cooldownDuration: 30_000 });
    this.algorithms = options.allowedAlgorithms ?? ['RS256', 'ES256', 'EdDSA'];
    if (this.algorithms.length === 0)
      throw new Error('At least one JWT signing algorithm is required');
  }

  async authenticate(authorization: string | undefined): Promise<ActorContext> {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? '');
    if (match?.[1] === undefined)
      throw new CoreError(401, 'unauthorized', 'A valid bearer token is required');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: [...this.algorithms],
        requiredClaims: ['sub', 'iss', 'exp', 'iat'],
      }));
    } catch {
      throw new CoreError(401, 'unauthorized', 'The bearer token is invalid or expired');
    }

    if (!hasExactAudience(payload.aud, this.options.audience)) {
      throw new CoreError(401, 'unauthorized', 'The bearer token targets a different resource');
    }

    const subject = payload.sub;
    const issuer = payload.iss;
    if (subject === undefined || issuer === undefined) {
      throw new CoreError(401, 'unauthorized', 'The bearer token has no issuer or subject');
    }
    const tokenScopeIds = readTokenScopeIds(payload);
    if (tokenScopeIds.length === 0)
      throw new CoreError(403, 'forbidden', 'The token grants no memory scopes');
    const tokenCapabilities = readTokenCapabilities(payload);
    if (tokenCapabilities.length === 0) {
      throw new CoreError(403, 'forbidden', 'The token grants no memory operation scopes');
    }

    const principalResult = await this.options.pool.query<PrincipalRow>(
      'SELECT user_id, principal_id, actor_kind FROM app.resolve_principal($1, $2)',
      [issuer, subject],
    );
    const principal = principalResult.rows[0];
    if (principal === undefined)
      throw new CoreError(401, 'unauthorized', 'The token subject is not registered');

    const grants = await withTransaction(this.options.pool, async (client) => {
      await client.query("SELECT set_config('app.user_id', $1, true)", [principal.user_id]);
      await client.query("SELECT set_config('app.scope_ids', $1, true)", [
        uuidArray(tokenScopeIds),
      ]);
      const result = await client.query<GrantRow>(
        `SELECT s.id AS scope_id, s.auth_epoch, g.capabilities
         FROM scopes AS s
         JOIN grants AS g ON g.user_id = s.user_id AND g.scope_id = s.id
         WHERE s.user_id = $1 AND g.principal_id = $2 AND s.id = ANY($3::uuid[])
           AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
         ORDER BY s.id`,
        [principal.user_id, principal.principal_id, tokenScopeIds],
      );
      return result.rows;
    });

    if (grants.length === 0)
      throw new CoreError(403, 'forbidden', 'The principal has no grant in the requested scopes');
    const scopeIds = grants.map((grant) => grant.scope_id);
    const authEpochs = Object.fromEntries(
      grants.map((grant) => [grant.scope_id, Number(grant.auth_epoch)]),
    );
    const databaseCapabilities = expandCapabilities(
      grants.flatMap((grant) => grant.capabilities).filter(isCapability),
    );
    const capabilities = tokenCapabilities.filter((capability) =>
      databaseCapabilities.has(capability),
    );
    return Object.freeze({
      userId: principal.user_id,
      principalId: principal.principal_id,
      actorKind: principal.actor_kind,
      scopeIds: Object.freeze(scopeIds),
      tokenScopeIds: Object.freeze(tokenScopeIds),
      capabilities: Object.freeze(capabilities),
      authEpochs: Object.freeze(authEpochs),
    });
  }
}

export function hasExactAudience(audience: JWTPayload['aud'], expected: string): boolean {
  return (
    audience === expected ||
    (Array.isArray(audience) && audience.length === 1 && audience[0] === expected)
  );
}

export function hasExactOAuthScopeClaims(
  payload: JWTPayload,
  expectedScopeId: string,
  expectedMemoryScope: 'memory:read' | 'memory:write',
): boolean {
  const scopeIds = payload[tokenScopesClaim];
  if (!Array.isArray(scopeIds) || scopeIds.length !== 1 || scopeIds[0] !== expectedScopeId) {
    return false;
  }

  const scopes = typeof payload['scope'] === 'string' ? payload['scope'].split(/\s+/) : [];
  const capabilityScopes = scopes.filter((scope) => memoryCapabilityScopes.has(scope));
  const unsupportedMemoryScopes = scopes.filter(
    (scope) =>
      scope.startsWith('memory:') &&
      !memoryCapabilityScopes.has(scope) &&
      !memorySupportScopes.has(scope),
  );
  return (
    scopes.includes(expectedMemoryScope) &&
    capabilityScopes.length === 1 &&
    capabilityScopes[0] === expectedMemoryScope &&
    unsupportedMemoryScopes.length === 0
  );
}

function readTokenScopeIds(payload: JWTPayload): string[] {
  const raw = payload[tokenScopesClaim];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new CoreError(403, 'forbidden', 'The bearer token has no valid scope grant');
  }
  const values = raw.map((value) => uuidSchema.safeParse(value));
  if (values.some((value) => !value.success)) {
    throw new CoreError(403, 'forbidden', 'The bearer token has an invalid scope grant');
  }
  return [...new Set(values.flatMap((value) => (value.success ? [value.data] : [])))].sort();
}

function readTokenCapabilities(payload: JWTPayload): Capability[] {
  const raw = payload['scope'];
  if (typeof raw !== 'string') return [];
  const mapped = new Set<Capability>();
  for (const value of raw.split(/\s+/).filter(Boolean)) {
    if (value === 'memory:read') mapped.add('read');
    if (value === 'memory:write') mapped.add('write');
    if (value === 'memory:admin') {
      mapped.add('read');
      mapped.add('write');
      mapped.add('admin');
    }
  }
  return [...mapped];
}

function expandCapabilities(values: readonly Capability[]): Set<Capability> {
  const caps = new Set(values);
  if (caps.has('admin')) {
    caps.add('read');
    caps.add('write');
  }
  return caps;
}

function isCapability(value: string): value is Capability {
  return value === 'read' || value === 'write' || value === 'admin';
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
