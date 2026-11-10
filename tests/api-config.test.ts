import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../apps/api/src/config.js';

const key = (byte: number, length = 32) => Buffer.alloc(length, byte).toString('base64url');

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '8080',
    FIRESTORE_PROJECT_ID: 'example-project',
    FIRESTORE_DATABASE_ID: 'lore-memory-records',
    LEDGER_DATABASE_ID: 'lore-deletion-ledger',
    GATE_ISSUER: 'https://gate.example.com',
    MCP_RESOURCE_URL: 'https://lore.example.com/mcp',
    GATE_MCP_CLIENT_ID: 'lore-mcp-resource',
    GATE_MCP_CLIENT_SECRET: 'synthetic-resource-secret',
    CURSOR_HMAC_KEYS: `k2026a=${key(1)},k2026b=${key(2, 48)}`,
    CURSOR_HMAC_ACTIVE_KEY: 'k2026b',
    VERTEX_PROJECT_ID: 'example-project',
    VERTEX_LOCATION: 'asia-southeast1',
    EMBEDDING_MODEL: 'gemini-embedding-001',
    ...overrides,
  };
}

function problems(overrides: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(environment(overrides));
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('API configuration', () => {
  it('reads a complete production environment', () => {
    const config = loadConfig(environment());
    expect(config).toMatchObject({
      port: 8080,
      firestoreProjectId: 'example-project',
      firestoreDatabaseId: 'lore-memory-records',
      ledgerDatabaseId: 'lore-deletion-ledger',
      gateIssuer: 'https://gate.example.com',
      mcpResourceUrl: 'https://lore.example.com/mcp',
      mcpAllowedHosts: ['lore.example.com'],
      cursorKeyId: 'k2026b',
      embedding: {
        provider: 'vertex',
        projectId: 'example-project',
        location: 'asia-southeast1',
        model: 'gemini-embedding-001',
        dimension: 768,
      },
      allowLoopbackHttp: false,
    });
    expect(config.cursorSecret.equals(Buffer.alloc(48, 2))).toBe(true);
  });

  it('defaults the port and accepts extra MCP hosts', () => {
    const config = loadConfig(
      environment({
        PORT: undefined,
        MCP_ALLOWED_HOSTS: 'lore-api.example.test, Other.example.com',
      }),
    );
    expect(config.port).toBe(8080);
    expect(config.mcpAllowedHosts).toEqual([
      'lore.example.com',
      'lore-api.example.test',
      'other.example.com',
    ]);
  });

  it('reports every missing value at once without echoing values', () => {
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: 'production', GATE_MCP_CLIENT_SECRET: 'synthetic-secret-value' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.problems).toEqual(
      expect.arrayContaining([
        'FIRESTORE_PROJECT_ID is required',
        'FIRESTORE_DATABASE_ID is required',
        'LEDGER_DATABASE_ID is required',
        'GATE_ISSUER is required',
        'MCP_RESOURCE_URL is required',
        'GATE_MCP_CLIENT_ID is required',
        'CURSOR_HMAC_KEYS and CURSOR_HMAC_ACTIVE_KEY are required',
        'VERTEX_PROJECT_ID is required',
        'VERTEX_LOCATION is required',
        'EMBEDDING_MODEL is required',
      ]),
    );
    expect(error.message).not.toContain('synthetic-secret-value');
  });

  it('validates the cursor key ring and the active key', () => {
    expect(problems({ CURSOR_HMAC_ACTIVE_KEY: 'missing' })).toEqual([
      'CURSOR_HMAC_ACTIVE_KEY must name a key in CURSOR_HMAC_KEYS',
    ]);
    expect(problems({ CURSOR_HMAC_ACTIVE_KEY: undefined })).toEqual([
      'CURSOR_HMAC_KEYS and CURSOR_HMAC_ACTIVE_KEY are required',
    ]);
    for (const keys of [
      `short=${key(1, 31)}`,
      `bad id=${key(1)}`,
      `${key(1)}`,
      `dup=${key(1)},dup=${key(2)}`,
      `toolongidentifier-0123456789abcdefgh=${key(1)}`,
    ]) {
      expect(problems({ CURSOR_HMAC_KEYS: keys, CURSOR_HMAC_ACTIVE_KEY: 'short' })).toContain(
        'CURSOR_HMAC_KEYS must hold unique key-id=base64url entries of at least 32 bytes each',
      );
    }
  });

  it('requires HTTPS Gate and resource URLs in production', () => {
    expect(problems({ GATE_ISSUER: 'https://gate.example.com/' })).toEqual([
      'GATE_ISSUER must be an HTTPS origin without a path or trailing slash',
    ]);
    expect(problems({ GATE_ISSUER: 'http://127.0.0.1:9000' })).toHaveLength(1);
    expect(problems({ MCP_RESOURCE_URL: 'https://lore.example.com/api' })).toHaveLength(1);
    expect(problems({ MCP_RESOURCE_URL: 'https://lore.example.com/mcp?x=1' })).toHaveLength(1);
    expect(problems({ MCP_RESOURCE_URL: 'http://lore.example.com/mcp' })).toHaveLength(1);
    expect(problems({ ALLOW_LOOPBACK_HTTP: '1' })).toEqual([
      'ALLOW_LOOPBACK_HTTP is forbidden when NODE_ENV is production',
    ]);
  });

  it('allows loopback HTTP and deterministic embeddings only outside production', () => {
    const local = loadConfig(
      environment({
        NODE_ENV: 'test',
        ALLOW_LOOPBACK_HTTP: '1',
        GATE_ISSUER: 'http://127.0.0.1:9000',
        MCP_RESOURCE_URL: 'http://127.0.0.1:9001/mcp',
        EMBEDDING_PROVIDER: 'deterministic',
        VERTEX_PROJECT_ID: undefined,
        VERTEX_LOCATION: undefined,
        EMBEDDING_MODEL: undefined,
      }),
    );
    expect(local.embedding).toEqual({ provider: 'deterministic' });
    expect(local.mcpAllowedHosts).toEqual(['127.0.0.1:9001']);
    expect(problems({ EMBEDDING_PROVIDER: 'deterministic' })).toEqual([
      'EMBEDDING_PROVIDER=deterministic is forbidden when NODE_ENV is production',
    ]);
    expect(
      problems({
        NODE_ENV: 'test',
        GATE_ISSUER: 'http://gate.example.com',
        ALLOW_LOOPBACK_HTTP: '1',
      }),
    ).toHaveLength(1);
  });

  it('keeps the deletion ledger in its own database and checks identifiers', () => {
    expect(problems({ LEDGER_DATABASE_ID: 'lore-memory-records' })).toEqual([
      'LEDGER_DATABASE_ID must differ from FIRESTORE_DATABASE_ID',
    ]);
    expect(problems({ FIRESTORE_PROJECT_ID: 'Example_Project' })).toHaveLength(1);
    expect(problems({ VERTEX_LOCATION: 'global' })).toHaveLength(1);
    expect(problems({ PORT: '70000' })).toEqual(['PORT must be an integer from 1 to 65535']);
    expect(problems({ EMBEDDING_DIMENSION: '0' })).toHaveLength(1);
    expect(problems({ EMBEDDING_PROVIDER: 'openai' })).toEqual([
      'EMBEDDING_PROVIDER must be vertex or deterministic',
    ]);
  });
});
