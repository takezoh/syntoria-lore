import { createHmac } from 'node:crypto';
import { LEGACY_FORGET_DIGEST_CONTEXT } from '@memory/contracts';

export function sourceIdentityDigest(
  key: string,
  scopeId: string,
  sourceKind: string,
  externalId: string,
  revision: string,
): string {
  return locatorDigest(key, scopeId, 'source', `${sourceKind}\u0000${externalId}\u0000${revision}`);
}

export function observationLocatorDigest(
  key: string,
  scopeId: string,
  sourceKind: string,
  externalId: string,
  revision: string,
  locator: string,
): string {
  return locatorDigest(
    key,
    scopeId,
    'locator',
    `${sourceKind}\u0000${externalId}\u0000${revision}\u0000${locator}`,
  );
}

function locatorDigest(key: string, scopeId: string, kind: string, value: string): string {
  if (Buffer.byteLength(key) < 32)
    throw new Error('FORGET_HMAC_KEY must contain at least 32 bytes');
  return createHmac('sha256', key)
    .update(`${LEGACY_FORGET_DIGEST_CONTEXT}\u0000${scopeId}\u0000${kind}\u0000${value}`)
    .digest('hex');
}
