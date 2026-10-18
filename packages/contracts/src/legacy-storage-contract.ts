/**
 * Persisted v1 identifiers from the previous product name. These values are
 * cryptographic/wire compatibility bytes; changing any value makes existing
 * encrypted exports, forgotten-source digests, or database locks unreadable.
 */
export const LEGACY_PORTABILITY_AAD = 'thymesis.portable.bundle.v1' as const;
export const LEGACY_PORTABILITY_BUNDLE_FORMAT = 'thymesis-portable-v1' as const;
export const LEGACY_PORTABILITY_HKDF_SALT = 'thymesis-portability-v1' as const;
export const LEGACY_PORTABILITY_PAYLOAD_FORMAT = 'thymesis.portable.data' as const;
export const LEGACY_PORTABILITY_MIME_TYPE = 'application/vnd.thymesis.portable+encrypted' as const;
export const LEGACY_FORGET_DIGEST_CONTEXT = 'thymesis-forget-v1' as const;
export const LEGACY_SCOPE_WRITE_LOCK_PREFIX = 'thymesis-scope-write:' as const;

/** Existing artifact envelopes authenticate these signer identifiers. */
export const LEGACY_LOCAL_PORTABILITY_SIGNER_ID = 'thymesis-local' as const;
export const LEGACY_CLOUD_PORTABILITY_SIGNER_ID = 'thymesis-cloud' as const;
export const LEGACY_LOCAL_ISSUER_KEY_ID = 'thymesis-local-rs256-v1' as const;
