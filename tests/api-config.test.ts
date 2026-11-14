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
    ACCESS_ISSUER: 'https://access.example.com',
    ACCESS_AUDIENCE: 'synthetic-access-app',
    ACCESS_OWNER_EMAIL: 'owner@example.com',
    OWNER_ADMISSION_ISSUER: 'https://identity.example.com',
    OWNER_ADMISSION_SUBJECT: 'existing-owner',
    MCP_RESOURCE_URL: 'https://lore.example.com/mcp',
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
  it('requires explicit valid configuration to enable recall assessment', () => {
    expect(loadConfig(environment()).recallAssessment).toBeUndefined();
    expect(
      loadConfig(environment({ RECALL_ASSESSMENT_MODEL: 'gemini-2.5-flash' })).recallAssessment,
    ).toEqual({
      projectId: 'example-project',
      location: 'asia-southeast1',
      model: 'gemini-2.5-flash',
    });
    expect(problems({ RECALL_ASSESSMENT_MODEL: '' })).toContain(
      'RECALL_ASSESSMENT_MODEL is required',
    );
    expect(
      problems({
        RECALL_ASSESSMENT_MODEL: 'gemini-2.5-flash',
        EMBEDDING_PROVIDER: 'deterministic',
        NODE_ENV: 'test',
      }),
    ).toContain('RECALL_ASSESSMENT_MODEL requires Vertex configuration');
  });
  it('reads a complete production environment', () => {
    const config = loadConfig(environment());
    expect(config).toMatchObject({
      port: 8080,
      firestoreProjectId: 'example-project',
      firestoreDatabaseId: 'lore-memory-records',
      ledgerDatabaseId: 'lore-deletion-ledger',
      access: {
        issuer: 'https://access.example.com',
        audience: 'synthetic-access-app',
        ownerEmail: 'owner@example.com',
        admissionIssuer: 'https://identity.example.com',
        admissionSubject: 'existing-owner',
      },
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
      loadConfig({ NODE_ENV: 'production', OWNER_ADMISSION_SUBJECT: 'synthetic-secret-value' });
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
        'ACCESS_ISSUER is required',
        'ACCESS_AUDIENCE is required',
        'ACCESS_OWNER_EMAIL is required',
        'OWNER_ADMISSION_ISSUER is required',
        'MCP_RESOURCE_URL is required',
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

  it('requires an HTTPS Access issuer and resource URL in production', () => {
    expect(problems({ ACCESS_ISSUER: 'https://access.example.com/' })).toEqual([
      'ACCESS_ISSUER must be an exact HTTPS origin',
    ]);
    expect(problems({ ACCESS_ISSUER: 'http://127.0.0.1:9000' })).toHaveLength(1);
    expect(problems({ ACCESS_OWNER_EMAIL: 'owner' })).toEqual([
      'ACCESS_OWNER_EMAIL must be an email address',
    ]);
    expect(problems({ ACCESS_AUDIENCE: 'two audiences' })).toEqual([
      'ACCESS_AUDIENCE must be one application audience',
    ]);
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
        MCP_RESOURCE_URL: 'http://lore.example.com/mcp',
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
