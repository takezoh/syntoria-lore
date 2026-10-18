import type { JWTVerifyGetKey } from 'jose';
import type { Config, Oidc } from './server.mjs';
export function createOidc(config: Config, fetcher?: typeof fetch): Promise<Oidc>;
export function verifyIdentity(
  token: string,
  keys: JWTVerifyGetKey,
  config: Config & { nonce: string },
): Promise<{ expiresAt: number }>;
