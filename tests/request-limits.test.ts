import { describe, expect, it } from 'vitest';
import { RequestLimits } from '../apps/api/src/request-limits.js';

describe('request limits', () => {
  const create = (options: { maxEntries?: number } = {}) => {
    let now = 1_000_000;
    const limits = new RequestLimits({
      connectionLimit: 3,
      unauthenticatedLimit: 2,
      now: () => now,
      ...options,
    });
    return { limits, advance: (ms: number) => (now += ms) };
  };

  it('keeps failed authentications from blocking a credential that verified recently', () => {
    const { limits, advance } = create();
    expect(limits.admitCredential('proxy', 'owner-token')).toBe(true);
    limits.recordVerified('owner-token');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(limits.admitCredential('proxy', `forged-${attempt}`)).toBe(true);
      limits.recordFailure('proxy');
    }
    expect(limits.admitCredential('proxy', 'forged-next')).toBe(false);
    expect(limits.admitCredential('proxy', undefined)).toBe(false);
    expect(limits.admitCredential('proxy', 'owner-token')).toBe(true);
    expect(limits.admitCredential('other-address', 'forged-next')).toBe(true);
    advance(60_000);
    expect(limits.admitCredential('proxy', 'forged-next')).toBe(true);
    advance(600_000);
    limits.recordFailure('proxy');
    limits.recordFailure('proxy');
    expect(limits.admitCredential('proxy', 'owner-token')).toBe(false);
  });

  it('counts authenticated requests per connection, not per address', () => {
    const { limits, advance } = create();
    for (let request = 0; request < 3; request += 1) {
      expect(limits.admitConnection('connection-a')).toBe(true);
    }
    expect(limits.admitConnection('connection-a')).toBe(false);
    expect(limits.admitConnection('connection-b')).toBe(true);
    advance(60_000);
    expect(limits.admitConnection('connection-a')).toBe(true);
  });

  it('bounds the entries it keeps', () => {
    const { limits } = create({ maxEntries: 2 });
    for (const connection of ['a', 'b', 'c', 'd']) limits.admitConnection(connection);
    for (const credential of ['t1', 't2', 't3']) limits.recordVerified(credential);
    expect(limits.admitConnection('d')).toBe(true);
    limits.recordFailure('proxy');
    limits.recordFailure('proxy');
    expect(limits.admitCredential('proxy', 't3')).toBe(true);
    expect(limits.admitCredential('proxy', 't1')).toBe(false);
  });
});
