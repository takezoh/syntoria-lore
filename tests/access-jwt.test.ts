import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessVerifier } from '../apps/api/src/access.js';
import { loadConfig } from '../apps/api/src/config.js';

const config = {
  issuer: 'https://access.example.com',
  audience: 'synthetic-audience',
  ownerEmail: 'owner@example.com',
};
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createAccessVerifier>;
beforeAll(async () => {
  key = await generateKeyPair('RS256');
  const jwk = await exportJWK(key.publicKey);
  verify = createAccessVerifier(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'local' }] }));
});
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: config.ownerEmail, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject('owner-access-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);
}
describe('Access owner authentication', () => {
  it('verifies a human owner assertion independently of client identity', async () => {
    await expect(verify.authenticate(await token())).resolves.toBeUndefined();
    await expect(
      verify.authenticate(await token({ client_id: 'untrusted-ai-name' })),
    ).resolves.toBeUndefined();
  });
  it('rejects absent, malformed, wrong-audience, expired and forged assertions', async () => {
    for (const value of [undefined, 'opaque-legacy-token']) {
      await expect(verify.authenticate(value)).rejects.toMatchObject({ status: 401 });
    }
    const bad = await new SignJWT({ email: config.ownerEmail })
      .setProtectedHeader({ alg: 'RS256', kid: 'local' })
      .setIssuer(config.issuer)
      .setAudience('wrong')
      .setSubject('owner')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key.privateKey);
    await expect(verify.authenticate(bad)).rejects.toMatchObject({ status: 401 });
    const expired = await new SignJWT({ email: config.ownerEmail })
      .setProtectedHeader({ alg: 'RS256', kid: 'local' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('owner')
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(key.privateKey);
    await expect(verify.authenticate(expired)).rejects.toMatchObject({ status: 401 });
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: config.ownerEmail })
      .setProtectedHeader({ alg: 'RS256', kid: 'local' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('owner')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verify.authenticate(forged)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects another user and service-token identities', async () => {
    await expect(
      verify.authenticate(await token({ email: 'other@example.com' })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(verify.authenticate(await token({ email: undefined }))).rejects.toMatchObject({
      status: 403,
    });
  });
  it('keeps key-service failures distinct from invalid credentials', async () => {
    const unavailable = createAccessVerifier(config, async () => {
      throw new Error('network');
    });
    await expect(unavailable.authenticate(await token())).rejects.toMatchObject({ status: 503 });
  });
  it('loads Access mode without any Gate credential', () => {
    const loaded = loadConfig({
      NODE_ENV: 'production',
      FIRESTORE_PROJECT_ID: 'example-project',
      FIRESTORE_DATABASE_ID: 'lore-records',
      LEDGER_DATABASE_ID: 'lore-ledger',
      ACCESS_ISSUER: config.issuer,
      ACCESS_AUDIENCE: config.audience,
      ACCESS_OWNER_EMAIL: config.ownerEmail,
      OWNER_ADMISSION_ISSUER: 'https://previous-identity.example.com',
      OWNER_ADMISSION_SUBJECT: 'existing-owner',
      MCP_RESOURCE_URL: 'https://lore.example.com/mcp',
      CURSOR_HMAC_KEYS: `one=${Buffer.alloc(32, 1).toString('base64url')}`,
      CURSOR_HMAC_ACTIVE_KEY: 'one',
      VERTEX_PROJECT_ID: 'example-project',
      VERTEX_LOCATION: 'asia-southeast1',
      EMBEDDING_MODEL: 'gemini-embedding-001',
    });
    expect(loaded.access?.admissionSubject).toBe('existing-owner');
    expect(loaded.gateClientSecret).toBe('');
  });
});
