# Approval policy production release

## Outcome

On 2026-10-29, Lore API revision `lore-api-policy-36b3225` began serving 100% of traffic, and migration 0048 was applied. Every binding now uses the `auto` approval policy of [ADR 0004](../adr/0004-approve-protected-changes-by-policy.md): a protected change an AI connection requests is applied at once and recorded as approved by policy, instead of waiting for the person at Gate. A binding that would let a connection act as the user principal is refused. Authenticated requests count against a per-connection budget, failed authentications against a per-address budget, and every API response sends HSTS. The owner directed automatic approval for production and authorized deploying all services on 2026-10-29. Private origins, identity values and credential payloads are not included here.

## Source and artifacts

| Component | Source commit | Active revision or execution | Image digest |
| --- | --- | --- | --- |
| API | `36b3225` | `lore-api-policy-36b3225` | `sha256:d84fea48481fe10561ab8b91607f5891982633aed93fe19aed33f457aacaafc9` |
| Migration job | `36b3225` | `lore-neon-migrate-pbt7h` | same image |

- The image was built by Cloud Build `5e1fe25a-53b2-4b1a-b4cd-425b80743983`.
- The release carries `1c25e89` (approval policy and migration 0048), `1eb7fb1` (request budgets and HSTS), `ee54b40` and `36b3225` (synthetic tracked deployment files).
- Shared Gate was released the same day as revision `gate-api-signout-d843db2`; its record is kept in the Gate repository.

## Configuration and migrations

- The `lore-neon-migrate` job was moved to the new image. Execution `lore-neon-migrate-pbt7h` applied `0048_connection_approval_policy.sql` and reported `migration_count=48`, `reapply=passed`, `status=migrated` and worker membership.
- The API revision reuses the serving configuration of `lore-api-split-a63458f` and changes only the image, deployed with `gcloud run deploy --image --no-traffic --tag`. Secret versions, runtime identity, IAM and limits are unchanged. No new setting is required.
- The worker keeps its previous image. Service accounts, IAM, DNS, secret versions and stored data other than the migration were not changed.
- Afterwards the ignored production profile was reconciled with the serving configuration, and the job renderer now sets the second-generation execution environment the migration job uses.

## Hosted checks

- **Candidate revision, through a no-traffic tag:** `/readyz` 200 with `Strict-Transport-Security: max-age=31536000`; `GET /v1/changes` 401 without a credential and with a forged bearer; `PUT /v1/scopes/{id}/retention` 401 with a forged bearer. The tag was removed after traffic moved.
- **Public origin after 100% traffic:** `/readyz` 200 with the same HSTS header; unauthenticated MCP write POST 401; MCP write resource metadata 200.

## Limits

- These probes establish readiness, HSTS and negative authentication boundaries only.
- The production binding's `approval_policy` and connection principal were not read back; the migration credential stays with the owner. Migration 0048 sets `auto` for every binding and gives a user-principal binding its connection principal, as verified locally.
- No AI connection has requested a protected change in production since the release, so policy approval, its `approval: "policy"` record and the `ai_proposal` status of a connection's own writes are verified only against local PostgreSQL.
- The per-connection and failure budgets were not exercised against the hosted API.

## Rollback

- Route API traffic back to `lore-api-split-a63458f`. Migration 0048 stays applied; that image ignores the approval policy and asks the person at Gate for every protected change.
- The previous migration job image is `sha256:f5147c7ace0b3b48a21dfd66c19c08bb0dbeae6ea3540f831db62c587724f1b4`.
- To keep the new image but restore per-change approval, set the binding's policy to `gate` with the identity-mapping tool (`--approval gate`).
