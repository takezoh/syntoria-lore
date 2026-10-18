# Deployment and operations

Executable commands for each step are in the [infrastructure runbook](infrastructure-runbook.md). Current observed status and open gates are in the [cloud verification register](../eval/cloud-verification.md).

## Environment contract

The cloud environment has one GCP project (`example-project`, region `asia-southeast1`) containing the API and worker services, the identity service, Cloud Tasks queue, Scheduler job, Cloud Run Jobs for migration and ledger reconciliation, Artifact Registry, Cloud Build source bucket, ledger and artifact buckets, Secret Manager and dedicated service accounts; and one Neon project in AWS `ap-southeast-1`. [deployment.json](../../infra/cloud/deployment.json) declares every name, limit and secret version; [iam-contract.json](../../infra/cloud/iam-contract.json) declares direct IAM. The local Compose stack runs the same entry points with fixture identity, tasks, scheduler and providers; it is not deployed acceptance.

Configuration is explicit and validated at startup:

| Configuration | Meaning |
| --- | --- |
| `DATABASE_URL` / `WORKER_DATABASE_URL` secret versions | Runtime database logins for API and worker; never the migration URL |
| `AUTH_ISSUER`, `AUTH_JWKS_URL` | Exact Keycloak realm issuer and key set |
| `AUTH_AUDIENCE`, `AUTH_MCP_READ_AUDIENCE`, `AUTH_MCP_WRITE_AUDIENCE`, `API_RESOURCE_URL`, `MCP_RESOURCE_BASE_URL` | Canonical resources for REST and the two MCP endpoints |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | Accepted Host and Origin values for MCP |
| `TASK_DISPATCH_MODE=cloud-tasks`, `CLOUD_TASKS_*`, `WORKER_TASK_URL`, `TASK_INVOKER_SERVICE_ACCOUNT`, `WORKER_PRIVATE_IAM=true` | Task creation and the worker's private IAM boundary |
| `STORAGE_MODE=gcs`, `GCS_LEDGER_BUCKET`, `GCS_ARTIFACT_BUCKET` and prefixes | Deletion ledger and export artifact storage |
| `CURATOR_PROVIDER=vertex`, `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `CURATOR_MODEL_ID`, `EMBEDDING_MODEL_ID`, `EMBEDDING_DIMENSION` | Extraction and embedding provider; no fallback |
| `FORGET_HMAC_KEY`, `PORTABILITY_MASTER_KEY`, `CURSOR_HMAC_KEYS`, `CURSOR_HMAC_ACTIVE_KEY` secret versions | Deletion-ledger integrity, export encryption and cursor signing |
| `PRODUCT_DISPLAY_NAME` | Name shown to clients |

Secret payloads never enter manifests, the build context or logs. Add new Secret Manager versions instead of overwriting, and change a manifest to a new version only after compatibility and rollback have been verified; never reference `latest`.

## State that must be preserved

The deployment configuration records the target identity service, the former identity source snapshot, user and synthetic identities, secret version references, the Neon migration state and the deletion ledger state. Reconcile these records with read-only observations before any repair. Never recreate identity users, reset Neon, rerun the empty-ledger bootstrap against an existing ledger, or remove IAM bindings to make a readback look clean.

As of 2026-10-18, the active Neon databases are `lore` and `lore_identity`. The app database has 41 migrations applied; all prior 40 checksums and normalized whole-row hashes for the 42 existing data tables were preserved. The identity service is `lore-identity` on revision `lore-identity-00001-zsq`; the API and worker are `lore-api-00002-pkv` and `lore-worker-00002-bww`. The identity service has the approved public invocation route; the API and worker remain IAM-private. Current hosted evidence and limits are in the [cloud verification register](../eval/cloud-verification.md).

The main ledger was bootstrapped once after an empty-database check and is reconciled; deployments run the reconcile Job, which checks the chain and should report `already-current`. The ledger bootstrap is only for a genuinely new, empty namespace. The user's password change and authenticator enrollment are human actions that automation never performs.

## Active state after naming cutover

The Lore target is active: the services, identity realm, Neon databases and buckets are in use under their Lore names. Migration preserved the existing identity, database roles and memberships, and ledger reconciliation reported `already-current` with zero replay and purge. The identity bootstrap Job completed the realm, client and scope rename but failed its final mapper-name readback because of a limitation in the pinned Keycloak API. A bounded offline correction applied the four mapper names, and a separate maintenance verification Job then passed the identity assertions. Do not describe the bootstrap Job itself as successful.

The former Thymesis cloud resources were deleted on 2026-10-18 after explicit user authorization: three services, three Jobs, one queue, one Scheduler job, three buckets, thirteen secrets, eight service accounts, one Artifact Registry repository and four custom IAM roles. The old project IAM bindings were removed. Fresh inventories found no active old resources in these categories; provider recovery records may remain under their retention policies. Lore services remain ready. Do not recreate old services or dispatch against data written to Lore. Historical source names and values in `deployment.json` are migration inputs and preservation evidence, not live service configuration. The user's password and TOTP enrollment and the 1Password connection-entry update remain pending. API and worker remain private, and external AI onboarding is not open. The original rename procedure is documented in [identity cutover](identity-cutover.md).

The user-identity release is recorded in [the release evidence](../eval/user-identity-release-20261018.md). API and worker remain IAM-private; ordinary user OAuth/MCP positive acceptance remains separate.

## Release sequence

1. Run the secret scan and generate an immutable source snapshot from the fixed allowlist outside the repository. Submit only that snapshot to Cloud Build with the dedicated build identity and source bucket, and read back the image digest. Never deploy a tag.
2. Render manifests from `deployment.json` with the runtime, Keycloak and proxy digests from the target repository. The renderer refuses tags, foreign repositories and nonempty output directories.
3. Run the Neon migration Job. It takes an advisory lock, verifies checksums, temporarily grants helper roles only what migrations require and verifies their cleanup. Inspect its terminal result before changing traffic.
4. Run the ledger reconcile Job and require `already-current` with zero replay on an unchanged ledger.
5. Replace the worker and confirm its custom audience, IAM-only invocation and the absence of public bindings. Then update the queue and the Scheduler job to the declared settings with OIDC for the canonical worker audience.
6. Replace the API with the same image digest, still IAM-private.
7. Capture IAM readbacks and run the boundary gate; stop on any drift.
8. Run the hosted verification harnesses and record their results in the verification register.

The identity bootstrap Job is a one-time setup that carries enrollment secrets; it is not part of an ordinary application release. The identity service is not rolled as a side effect of API or worker delivery.

## IAM and secret boundary

The boundary gate compares fresh readbacks with `iam-contract.json`: direct project roles for each service account, exact Secret Accessor members per secret, queue, registry and build-source bindings, service-account delegation, the worker's invokers, custom-role permissions and conditions, bucket members and artifact bucket settings. It fails closed on any added, missing or changed member or condition. Reconcile only the exact drift it reports; never replace a policy wholesale or remove unrelated operator or legacy bindings. A passing gate covers the named direct policies only, not inherited organization IAM.

Only the worker identity creates tasks and acts as the task-invoker account (the task-invoker account grants `roles/iam.serviceAccountUser` to the worker alone; the other service-account policies have no direct bindings); the task and scheduler invokers can invoke only the worker. API and worker read only their own database URL plus the Forget, portability and cursor keys. The migration identity reads only the app, worker and migration URLs; the identity and identity-bootstrap identities read only their declared identity secrets; the legacy identity database URL and the Neon migration URL have no direct service-account accessors. Ledger head, ledger node and artifact access are separate custom roles scoped by object name or prefix. Four legacy project-member bindings on the build-source bucket are declared and retained.

## Release gates

Check `/healthz` and `/readyz`. Verify issuer, JWKS, audiences and the separate MCP resources against the canonical URLs. Prove both sides of the worker boundary: anonymous calls are rejected by Cloud Run, and task and scheduler tokens with the canonical audience reach their routes. Exercise a real outbox job through Scheduler, Cloud Tasks and the worker to a terminal database state, inspect logs for content or secrets, and confirm failed or held work remains durable. Run the OAuth, governance and restore harnesses with disposable principals and scopes only.

A cloud smoke pass is not evidence of retrieval quality, latency objectives, capacity, cost, point-in-time recovery or production acceptance; those remain separate gates.

## Rollback and recovery

Roll back API or worker traffic only to a previous immutable revision compatible with the applied schema. Do not roll back Neon data, the ledger head, deletion-key lineage or artifact state together with a service revision; migrations are forward-only and repaired forward. Keep the durable outbox and let the next sweep recover interrupted dispatch.

For a database restore, restore into an isolated target, replay the latest deletion ledger before readiness and keep the service fail-closed until the checkpoint matches the ledger head. Record the rehearsal with the [recovery rehearsal template](../templates/recovery-rehearsal.md). Managed Neon point-in-time recovery and measured RPO/RTO have not yet been rehearsed.

## Release evidence

A release record binds the source manifest digest, Cloud Build ID, image digest, rendered configuration, secret version references (never values), migration result, Cloud Run revisions, timestamps, access scope and the actual verification results. Report identity, API, MCP, worker delivery, governance and restore separately. Local runs and document reviews are not hosted acceptance.
