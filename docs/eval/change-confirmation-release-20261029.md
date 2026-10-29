# Change confirmation production release

## Outcome

On 2026-10-29, Gate, Lore and Weave began serving the revisions below at 100% traffic. Gate hosts change confirmations, and unapproved DCR registrations now expire. Lore records the Gate client on each changeset and can route protected changes through Gate confirmations. Weave keeps 30 days of operations and records the committing client.

The connection-principal switch was set later the same day for the single production binding (see [Switch and follow-up release](#switch-and-follow-up-release)). Since then every Lore connection acts as a non-user connection principal, and user authority comes only from a change approved at Gate. The owner authorized this release on 2026-10-29 ("lore, gate, weave のデプロイを承認する"). Private origins, identity values and credential payloads are not included here.

## Source and artifacts

| Service | Source commit | Active revision | Image digest |
| --- | --- | --- | --- |
| Gate | `c2d093b` | `gate-api-confirm-c2d093b` | `sha256:38faebf473700eb6c5aa94ffa000735cb7e916509c9694d63875bdb48c6f9c3a` |
| Lore API | `bb819f3` | `lore-api-confirm-bb819f3` | `sha256:d2704ceabe609665b0c239eeeaed7cc774695f798d7c30abea90a9d748e0dc20` |
| Weave | `763791d` | `weave-api-retention-763791d` | `sha256:7787d24ee98df6b0b0da7d21899ca3623c5eb60ea2f6484a2e7960846f414b43` |

- Lore was built by Cloud Build `75395b2e-b937-4f77-8e0d-1f4c427b8c2d` from a frozen context whose manifest SHA-256 is `96cf98414b277d93decac8ee220c7f7613274bbbfa0b3a6e50565d92a1c30428`. Gate and Weave were built locally with Docker Buildx for `linux/amd64` and pushed to their existing repositories; their digests identify OCI indexes.
- The commits are local and were not pushed when this record was written.
- Weave's release also includes two earlier unreleased commits on its main branch, `42ac8a5` and `6cdba94`.

## Configuration and migrations

- **Gate.** The new revision reuses the serving configuration of `gate-api-davinci-20261024` and changes only the image: same runtime identity, secret versions, browser apps and limits. No new setting is required. Two Firestore TTL policies were added for `gate_confirmations` and `gate_confirmation_references` on `expiresAt`, matching `infra/terraform/main.tf`; both read back `ACTIVE`. Existing TTL policies were unchanged.
- **Lore.** The `lore-neon-migrate` job was moved to the new image. Execution `lore-neon-migrate-nbfhs` applied migrations 0044 to 0046 and reported `migration_count=46`, `reapply=passed`, non-bypass app and worker roles, and worker membership. The API reuses its existing configuration with the new image. The worker and the `lore-ledger-reconcile` job keep their previous image, as in the 2026-10-20 release; the 0045 grants let their Forget, retention and replay routines update `change_confirmations` through the suppression trigger.
- **Weave.** Backup execution `weave-backup-pkmb4` succeeded before migration (661,778 bytes). The `weave-migrator` job was moved to the new image, and execution `weave-migrator-t299q` applied `0005_operation_client_provenance.sql`. The new revision then passed its startup schema check. The `weave-backup` job now uses the new image as well.
- Candidate revisions were deployed without traffic and probed through revision tags before traffic moved. The tags were removed afterwards. Service accounts, IAM, DNS, secret versions and stored data other than the migrations were not changed.

## Hosted checks

Public HTTPS probes on 2026-10-29:

- **Gate:** `/readyz` 200; an unauthenticated `POST /confirmations` 401. On the candidate revision, OIDC discovery returned 200 and `/confirm` with an unknown ID returned 404.
- **Lore:** `/readyz` 200; unauthenticated MCP write POST 401; MCP write resource metadata 200. On the candidate revision, `GET /v1/confirmations/{id}` returned 401 with no credential and with an invalid bearer.
- **Weave:** `/health/ready` 200; MCP POST with an invalid bearer 401; untrusted-origin preflight 403; MCP resource metadata 200.

## Limits

- These probes establish readiness and negative authentication boundaries only.
- No real confirmation has been created, approved or consumed in production, and no AI connection has acted as a connection principal there. The local PostgreSQL and Firestore Emulator suites remain the evidence for those paths.
- Weave's period retention and client provenance were not exercised by a hosted write.
- The production binding's principal kind has not been read, so stage 3 of [ADR 0003](../adr/0003-attribute-ai-clients-and-confirm-user-decisions.md) cannot be enabled yet.

## Rollback

- **Gate:** route traffic back to `gate-api-davinci-20261024`. Confirmations created in the meantime then become unreachable.
- **Lore:** route traffic back to `lore-api-dcr-921e9c0` while the switch is unset. Migrations 0044 to 0046 stay applied, and the previous image works with them.
- **Weave:** the previous image fails its startup schema check after 0005. Roll forward with a fix instead.

## Switch and follow-up release

- **Switch.** On 2026-10-29 the owner ran the reviewed identity-mapping tool from their own shell, so the migration credential never reached the agent. The dry-run found exactly one active binding, whose principal is a `user`, with one scope and the `admin`, `read` and `write` ceiling. It was applied with that baseline. The readback shows the binding active and naming a new `client` connection principal. That principal is active, acts for the binding's user principal and holds no grants of its own.
- **Gap found.** After the switch, a connection could no longer read the review queue, and no one could enable a capture source, because both required the user actor. The owner chose to allow reading and to require approval for enabling.
- **Lore `a63458f`.** Cloud Build `b9ef3eb4-6783-4717-a962-3b53a9504ba2` produced image `sha256:f5147c7ace0b3b48a21dfd66c19c08bb0dbeae6ea3540f831db62c587724f1b4`. Execution `lore-neon-migrate-74bcb` applied `0047_confirm_source_configuration.sql` (`migration_count=47`, `reapply=passed`). Revision `lore-api-split-a63458f` was probed through a no-traffic tag (readiness 200, unauthenticated `POST /v1/connectors` 401) and then received 100% traffic. Public readiness returned 200 and an unauthenticated MCP write returned 401.
- **Not yet observed in production.** No confirmation has been created, approved or consumed, and no AI write has been checked to land as an AI proposal.

## Migration credential rotation

On 2026-10-29 the owner changed the Neon owner-role password and added version 2 of `lore-migration-direct-url` from their own terminal, so the value never reached the agent. `lore-neon-migrate` now references version 2. Execution `lore-neon-migrate-hzj2w` connected with it and reported `migration_count=47` and `reapply=passed` without changes. The Weave migrator (`weave-migrator-plnp6`) and backup (`weave-backup-g7pms`) jobs also succeeded afterwards, and Lore readiness, which checks its database connection, stayed 200. Version 1 holds a password that no longer authenticates.

