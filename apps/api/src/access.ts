import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessIdentityConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly ownerEmail: string;
}

export class AccessVerificationError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super(status === 503 ? 'Authorization unavailable' : 'Access denied');
  }
}

/** Verify the original assertion independently of gateway forwarding headers. */
export function createAccessVerifier(config: AccessIdentityConfig, testKeys?: JWTVerifyGetKey) {
  const issuer = new URL(config.issuer);
  if (
    issuer.protocol !== 'https:' ||
    issuer.origin !== config.issuer ||
    !/^[A-Za-z0-9_-]+$/u.test(config.audience) ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(config.ownerEmail)
  ) {
    throw new TypeError('Invalid Access configuration');
  }
  const keys =
    testKeys ??
    createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
      timeoutDuration: 5000,
    });
  return {
    async authenticate(assertion: string | undefined): Promise<void> {
      if (
        !assertion ||
        assertion.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(assertion)
      ) {
        throw new AccessVerificationError(401);
      }
      try {
        const { payload } = await jwtVerify(assertion, keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'iat', 'exp'],
        });
        if (!payload.sub || payload['email'] !== config.ownerEmail)
          throw new AccessVerificationError(403);
      } catch (error) {
        if (error instanceof AccessVerificationError) throw error;
        if (
          error instanceof errors.JOSEError &&
          !(error instanceof errors.JWKSTimeout) &&
          !(error instanceof errors.JWKSInvalid) &&
          !(error instanceof errors.JWKInvalid)
        )
          throw new AccessVerificationError(401);
        throw new AccessVerificationError(503);
      }
    },
  };
}
