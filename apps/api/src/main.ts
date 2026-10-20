import { createGovernanceStorage, getProductDisplayName, parsePort } from '@memory/runtime';
import { Authenticator } from '@memory/auth';
import { createDatabase, assertNobypassRls, pingDatabase } from '@memory/db';
import { CoreService, CursorCodec } from '@memory/domain';
import { ConnectorService } from '@memory/connectors';
import { createConfiguredCuratorProviders } from '@memory/curator';
import { RecallService } from '@memory/recall';
import { CurationReviewService } from '@memory/jobs';
import { ForgetService, PortabilityService } from '@memory/governance';
import { createApiServer } from './server.js';

const host = process.env['API_HOST'] ?? '0.0.0.0';
const productDisplayName = getProductDisplayName();
const portValue = process.env['PORT'] ?? process.env['API_PORT'];
const portVariable = process.env['PORT'] === undefined ? 'API_PORT' : 'PORT';
const port = parsePort(portValue, portVariable, 8080);
const pool = createDatabase(process.env['DATABASE_URL'], 5);
await assertNobypassRls(pool);
const issuer = canonicalIssuer(requiredEnvironment('AUTH_ISSUER'));
const audience = requiredEnvironment('AUTH_AUDIENCE');
const allowLoopbackHttp = process.env['AUTH_GATE_ALLOW_LOOPBACK_HTTP'] === '1';
const mcpBaseUrl = requiredEnvironment('MCP_BASE_URL');
const mcpReadAudience = canonicalMcpResource(mcpBaseUrl, 'read');
const mcpWriteAudience = canonicalMcpResource(mcpBaseUrl, 'write');
assertConfiguredAudience('AUTH_MCP_READ_AUDIENCE', mcpReadAudience);
assertConfiguredAudience('AUTH_MCP_WRITE_AUDIENCE', mcpWriteAudience);
const mcpAllowedHosts = (process.env['MCP_ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,::1')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const mcpAllowedOrigins = (process.env['MCP_ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const apiAllowedOrigins = parseOrigins(process.env['API_ALLOWED_ORIGINS'] ?? '');
const commonIdentityProviderConfig = {
  issuer,
  ...(allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
};
const auth = new Authenticator({
  pool,
  ...commonIdentityProviderConfig,
  audience,
  clientId: requiredEnvironment('AUTH_API_RESOURCE_CLIENT_ID'),
  clientSecret: requiredEnvironment('AUTH_API_RESOURCE_CLIENT_SECRET'),
});
const mcpReadAuth = new Authenticator({
  pool,
  ...commonIdentityProviderConfig,
  audience: mcpReadAudience,
  clientId: requiredEnvironment('AUTH_MCP_READ_RESOURCE_CLIENT_ID'),
  clientSecret: requiredEnvironment('AUTH_MCP_READ_RESOURCE_CLIENT_SECRET'),
});
const mcpWriteAuth = new Authenticator({
  pool,
  ...commonIdentityProviderConfig,
  audience: mcpWriteAudience,
  clientId: requiredEnvironment('AUTH_MCP_WRITE_RESOURCE_CLIENT_ID'),
  clientSecret: requiredEnvironment('AUTH_MCP_WRITE_RESOURCE_CLIENT_SECRET'),
});
const core = new CoreService(pool, CursorCodec.fromEnvironment());
const governanceStorage = createGovernanceStorage();
const providers = createConfiguredCuratorProviders();
const recall = new RecallService(pool, core, providers.embeddings);
const connectors = new ConnectorService(pool, {
  promptGeneration: providers.promptVersion,
  modelId: providers.extractionModelId,
});
const reviews = new CurationReviewService(pool, core);
const governance = new ForgetService(pool, governanceStorage.deletionLedger);
const portability = new PortabilityService(pool, governanceStorage.portabilityStore, {
  hmacKey: requiredEnvironment('FORGET_HMAC_KEY'),
});
const server = createApiServer({
  productDisplayName,
  auth,
  mcpReadAuth,
  mcpWriteAuth,
  mcpAuthorizationServerUrl: issuer,
  mcpResourceBaseUrl: mcpBaseUrl,
  apiAllowedOrigins,
  mcpAllowedHosts,
  ...(mcpAllowedOrigins.length === 0 ? {} : { mcpAllowedOrigins }),
  core,
  connectors,
  recall,
  reviews,
  governance,
  portability,
  ready: async () => {
    await pingDatabase(pool);
    await governance.verifyLedgerReadiness();
  },
});

server.listen(port, host, () => {
  console.log(`${productDisplayName} API listening on ${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => void pool.end());
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function canonicalIssuer(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.origin
  ) {
    throw new Error(
      'AUTH_ISSUER must be a canonical HTTPS Gate origin without credentials or a trailing slash',
    );
  }
  return parsed.origin;
}

function canonicalMcpResource(baseUrl: string, endpoint: 'read' | 'write'): string {
  const base = new URL(baseUrl);
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== '' ||
    (base.pathname !== '/' && base.pathname !== '')
  ) {
    throw new Error(
      'MCP_BASE_URL must be an HTTP origin without credentials, path, query, or fragment',
    );
  }
  return new URL(`/mcp/${endpoint}`, base).toString();
}

function assertConfiguredAudience(name: string, canonical: string): void {
  const configured = requiredEnvironment(name);
  if (configured !== canonical) {
    throw new Error(`${name} must equal the protected resource URL ${canonical}`);
  }
}

function parseOrigins(value: string): string[] {
  if (value.trim() === '') return [];
  const origins = value.split(',').map((entry) => entry.trim());
  if (origins.some((entry) => entry.length === 0)) {
    throw new Error('API_ALLOWED_ORIGINS must be a comma-separated list of exact origins');
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('API_ALLOWED_ORIGINS entries must be exact HTTP(S) origins');
    }
  }
  if (new Set(origins).size !== origins.length) {
    throw new Error('API_ALLOWED_ORIGINS must not contain duplicates');
  }
  return origins;
}
