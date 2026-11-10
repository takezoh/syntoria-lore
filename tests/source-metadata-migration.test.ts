import { describe, expect, it } from 'vitest';
import {
  prepareSourceMetadataMigration,
  verifiedOperatorEmailFromTokenInfo,
} from '../packages/memory-records/src/operator-maintenance.js';

const target = {
  projectId: 'demo-source-migration',
  databaseId: 'memory-records-test',
  deletionLedgerDatabaseId: 'deletion-ledger-test',
};

describe('source metadata migration preparation', () => {
  it('fails closed when the private persisted snapshot is missing', () => {
    expect(() =>
      prepareSourceMetadataMigration({}, { entries: [] }, target, 'synthetic-migration'),
    ).toThrow(/snapshot|collection/u);
  });

  it('rejects a target that cannot be bound to the manifest digest', () => {
    expect(() =>
      prepareSourceMetadataMigration(
        {},
        { entries: [] },
        { ...target, projectId: 'not a project' },
        'synthetic-migration',
      ),
    ).toThrow(/invalid/u);
  });
});

describe('Google tokeninfo operator identity', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');

  it('accepts the verified email string returned by Google tokeninfo', () => {
    expect(
      verifiedOperatorEmailFromTokenInfo(
        {
          email: 'operator@example.test',
          email_verified: 'true',
          expiry_date: now + 60_000,
        },
        now,
      ),
    ).toBe('operator@example.test');
  });

  it('accepts exact boolean verified-email representations', () => {
    expect(
      verifiedOperatorEmailFromTokenInfo(
        {
          email: 'operator@example.test',
          email_verified: true,
          expiry_date: now + 60_000,
        },
        now,
      ),
    ).toBe('operator@example.test');
    expect(
      verifiedOperatorEmailFromTokenInfo(
        {
          email: 'operator@example.test',
          verified_email: true,
          expiry_date: now + 60_000,
        },
        now,
      ),
    ).toBe('operator@example.test');
  });

  it('rejects false, missing, expired, and malformed token identities', () => {
    const base = { email: 'operator@example.test', expiry_date: now + 60_000 };
    for (const invalid of [
      { ...base, email_verified: 'false' },
      { ...base, email_verified: false },
      { ...base },
      { ...base, email_verified: 'true', expiry_date: now },
      { ...base, email: 'not-an-email', email_verified: 'true' },
      { ...base, email: 'operator@exa mple.test', email_verified: 'true' },
      { ...base, email_verified: 1 },
    ]) {
      expect(() => verifiedOperatorEmailFromTokenInfo(invalid, now)).toThrow(/identity/u);
    }
  });
});
