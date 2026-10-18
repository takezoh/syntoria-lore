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
const issuer = requiredEnvironment('AUTH_ISSUER');
const audience = requiredEnvironment('AUTH_AUDIENCE');
const jwksUrl = requiredEnvironment('AUTH_JWKS_URL');
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
const auth = new Authenticator({ pool, issuer, audience, jwksUrl });
const mcpReadAuth = new Authenticator({
  pool,
  issuer,
  audience: mcpReadAudience,
  jwksUrl,
});
const mcpWriteAuth = new Authenticator({
  pool,
  issuer,
  audience: mcpWriteAudience,
  jwksUrl,
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
const localRateLimit = process.env['LOCAL_RATE_LIMIT'];
if (localRateLimit !== undefined && process.env['LOCAL_AUTH_FIXTURE'] !== '1') {
  throw new Error('LOCAL_RATE_LIMIT requires the explicit local-auth fixture');
}
const server = createApiServer({
  productDisplayName,
  auth,
  mcpReadAuth,
  mcpWriteAuth,
  mcpAuthorizationServerUrl: issuer,
  mcpResourceBaseUrl: mcpBaseUrl,
  mcpAllowedHosts,
  ...(mcpAllowedOrigins.length === 0 ? {} : { mcpAllowedOrigins }),
  core,
  connectors,
  recall,
  reviews,
  governance,
  portability,
  ...(localRateLimit === undefined ? {} : { rateLimit: parseLocalRateLimit(localRateLimit) }),
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

function parseLocalRateLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 120 || parsed > 100_000) {
    throw new Error('LOCAL_RATE_LIMIT must be an integer between 120 and 100000');
  }
  return parsed;
}
