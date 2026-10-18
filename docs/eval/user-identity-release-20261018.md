# User identity release — 2026-10-18

The `user` / `user_id` release is active on the existing IAM-private Lore API and
worker. Identity, existing users and grants, secret versions and public access
were preserved. The complete machine-readable record is
[user-identity-release-20261018.json](user-identity-release-20261018.json).

## Source and artifact

- Base commit: `968127e316f3410dc7a52c6728329312d9e767e7`; the release includes
  uncommitted implementation changes, identified by the immutable source manifest.
- Source manifest SHA-256: `300b650e3b143d3f6d3f1b6a603bddf651586f385beb1572d422eb5f5cf3bddf`
  (204 allowlisted files, frozen before build).
- Regional Cloud Build: `72e236ee-217b-497b-938d-768a4b8554dc`, `SUCCESS`.
- Runtime image: `asia-southeast1-docker.pkg.dev/example-project/lore/runtime@sha256:47e114cd67bc7e25d1378d2b905542156e34efdaac1e9a41d63d7dc257609771`.
- API: `lore-api-00002-pkv`; worker: `lore-worker-00002-bww`. Both are ready,
  receive 100% of traffic and use the same digest with automatic scaling.
- Identity remains `lore-identity-00001-zsq`; no authentication bootstrap or
  enrollment operation was performed.

## Backup and maintenance window

Before touching the running services, a full PostgreSQL18 custom-format dump was
restored into an isolated PostgreSQL18/pgvector server. Source role attributes,
effective privileges across multiple grantors and database ownership were
reproduced. The normal cloud migration runner then passed as the non-superuser
migration role, including repeat application and temporary-helper cleanup.
Initial rehearsal failures came from incomplete fixture privilege/ownership
reproduction and were resolved in the isolated environment before production
maintenance began.

Scheduler and queue dispatch were paused. API and worker were disabled through
[manual scaling zero](https://docs.cloud.google.com/run/docs/configuring/services/manual-scaling),
without traffic tags. Runtime database logins were fenced, active requests were
allowed to drain, and one remaining idle connection was closed. At
`06:56:15.424Z`, both runtime roles were `NOLOGIN` and runtime session count was zero.
A final consistent dump and all-table content-hash baseline were then captured.

API disablement ran from `06:55:30.656855Z` to `07:02:15.622204Z` (about 6m45s).
Worker disablement ran from `06:55:34.777179Z` to `07:02:16.362276Z` (about 6m42s).
Only the new digest was enabled for readiness and authentication checks. Both
services returned to automatic scaling by `07:03:58.224779Z`; queue and Scheduler
were restored, with Scheduler `ENABLED` recorded at `07:04:21.592381Z`.

The fenced backup is retained at
`gs://example-lore-build-source/backups/user-identity-20261018/fenced-backup.dump.aes256gcm`,
with its adjacent `fenced-backup-manifest.json`. Only ciphertext and non-secret
metadata were uploaded to the existing private bucket. AES-256-GCM uses a random
salt and nonce; HKDF-SHA256 derives its key from the existing fixed Secret Manager
version referenced in the manifest, with domain `memory-user-identity-release-backup@1`.
The encrypted file is a JSON header plus newline plus ciphertext. The header holds
salt, nonce, key reference, plaintext SHA-256 and authentication tag; the same
header without the tag is the authenticated data. Successful local decryption
was checked byte-for-byte. Production credentials, local plaintext dumps and the
isolated restore container/volume were removed afterward.

## Production evidence

- Migration execution `lore-neon-migrate-k7t9g` passed: 41 migrations, reapply,
  non-bypass API/worker roles, worker membership and helper privilege cleanup.
- All 40 preceding migration checksums and normalized whole-row hashes for all
  42 existing data tables matched. Normalization covers only the declared user
  terminology/provenance transformation; caller content and arbitrary JSON were
  preserved.
- Existing principal issuer cutover reported `already-current`; four principal
  identities and existing grants were retained.
- Ledger execution `lore-ledger-reconcile-zrddt` reported `already-current`,
  zero replay, zero purge and ready. The existing fixed-v1 hash chain was retained.
- The 26 retained outbox records contained no `owner_id` / `ownerId` identity
  keys; Cloud Tasks had no pending entries. Task bodies remain strict `job_id`
  references and the worker resolves current user identity from the database.
- New API and worker `/readyz` returned 200; the API OpenAPI endpoint returned
  200. Anonymous access was rejected with 403. Missing application bearer tokens
  on REST/MCP, invalid MCP tokens and a wrong-issuer token were rejected with 401.
  All nine final probes passed after scaling/dispatch restoration.
- API and worker direct IAM policies matched their pre-release readbacks.
  Queue rate/retry settings, Scheduler schedule/OIDC and identity service
  configuration matched; queue is `RUNNING`, Scheduler is `ENABLED`.

## Limits

Ordinary user login and authorized OAuth/REST/MCP positive flows were not rerun:
user enrollment and disabled synthetic principals were left unchanged. The
readiness and negative probes do not establish end-user acceptance.

External `/healthz` returned 404 and is not counted as passed. The probe window
had no matching Cloud Run request log for `/healthz`, while `/readyz` had six,
suggesting an edge response. Earlier release records do not establish whether
this behavior is new or pre-existing. No route changes or wider investigation
were included in this release.

No latency/capacity, provider-quality, measured RPO/RTO, inherited-IAM or full
production acceptance claim follows from this release.
