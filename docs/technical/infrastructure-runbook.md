# Infrastructure runbook

This runbook lists the executable steps for building, deploying and verifying Lore on GCP and Neon. The reasons, ordering rules and preservation constraints are in [deployment](deployment.md); read them first. The Lore target is active: API, worker and identity run under Lore names, and the Neon databases are `lore` and `lore_identity`. The 37 former Thymesis cloud resources were deleted on 2026-10-18 with user authorization; see the [deletion record](../eval/cloud-verification.md#old-resource-deletion--2026-10-18). Do not recreate old services or dispatch against data written to Lore. The source fields in [deployment.json](../../infra/cloud/deployment.json) are migration history, not active endpoints. Never point a smoke at a production scope.

Run each `gcloud` command on its own and write outputs only to new private directories outside the repository. Keep tokens in mode-0600 files referenced by environment variables; the scripts never print them.

## Build the image

Scan for secrets, then create a read-only source snapshot from the fixed allowlist. The generator rejects symlinks and credential-shaped names, excludes environment and build artifacts and writes `source-manifest.json` with SHA-256 entries. Use a new empty directory for every build.

```sh
npm run secret:scan
npm run cloud:build-context -- --output-dir /tmp/memory-runtime-build-r3
```

Submit only that snapshot with the dedicated build identity, regional Cloud Build and `CLOUD_LOGGING_ONLY`:

```sh
gcloud builds submit /tmp/memory-runtime-build-r3 \
  --project=example-project \
  --region=asia-southeast1 \
  --config=/tmp/memory-runtime-build-r3/infra/cloud/cloudbuild.yaml \
  --gcs-source-staging-dir=gs://example-lore-build-source/source/r3
```

Read the immutable digest; never use the build tag as the service image:

```sh
gcloud builds describe BUILD_ID \
  --project=example-project \
  --region=asia-southeast1 \
  --format='value(results.images[0].digest)'
```

## Render manifests

Pass the runtime digest and the Keycloak and proxy digests from the target `lore` repository. The renderer writes eight mode-`0600` manifests into a new mode-`0700` directory and refuses tags, foreign repositories, output inside the repository and nonempty directories.

```sh
npm run cloud:manifests -- \
  --image asia-southeast1-docker.pkg.dev/example-project/lore/runtime@sha256:IMAGE_DIGEST \
  --identity-keycloak-image asia-southeast1-docker.pkg.dev/example-project/lore/identity-keycloak@sha256:KEYCLOAK_DIGEST \
  --identity-proxy-image asia-southeast1-docker.pkg.dev/example-project/lore/identity-proxy@sha256:PROXY_DIGEST \
  --output-dir /tmp/lore-cloud-manifests-r3
```

## Migrate and reconcile

Apply and run the migration Job before replacing services:

```sh
gcloud run jobs replace /tmp/lore-cloud-manifests-r3/neon-migration-job.json \
  --project=example-project --region=asia-southeast1
gcloud run jobs execute lore-neon-migrate \
  --project=example-project --region=asia-southeast1 --wait
```

Then the ledger chain check. On an unchanged ledger it must report `already-current` with zero replay and purge; it never creates a missing head.

```sh
gcloud run jobs replace /tmp/lore-cloud-manifests-r3/ledger-reconcile-job.json \
  --project=example-project --region=asia-southeast1
gcloud run jobs execute lore-ledger-reconcile \
  --project=example-project --region=asia-southeast1 --wait
```

## Deploy the worker, queue and Scheduler

```sh
gcloud run services replace /tmp/lore-cloud-manifests-r3/worker-service.json \
  --project=example-project --region=asia-southeast1
gcloud run services describe lore-worker \
  --project=example-project --region=asia-southeast1 \
  --format='value(metadata.annotations."run.googleapis.com/custom-audiences")'
```

The custom audience must be exactly `https://lore-worker-123456789012.asia-southeast1.run.app`. The service-level invokers must be only `lore-task-invoker` and `lore-scheduler-invoker`; confirm there is no `allUsers` binding and that an anonymous request is rejected. Then update the queue and the minute Scheduler job:

```sh
gcloud tasks queues update lore-capture \
  --project=example-project --location=asia-southeast1 \
  --max-concurrent-dispatches=2 --max-dispatches-per-second=2 \
  --max-attempts=5 --max-retry-duration=3600s \
  --min-backoff=10s --max-backoff=300s
```

```sh
gcloud scheduler jobs update http lore-worker-sweep \
  --project=example-project --location=asia-southeast1 \
  --schedule='* * * * *' --time-zone=Etc/UTC \
  --uri=https://lore-worker-123456789012.asia-southeast1.run.app/internal/dispatch/sweep \
  --http-method=POST --message-body='{}' \
  --update-headers=Content-Type=application/json \
  --oidc-service-account-email=lore-scheduler-invoker@example-project.iam.gserviceaccount.com \
  --oidc-token-audience=https://lore-worker-123456789012.asia-southeast1.run.app
```

## Deploy the API

Replace the API with the same image digest. It stays IAM-authenticated; do not add `allUsers`.

```sh
gcloud run services replace /tmp/lore-cloud-manifests-r3/api-service.json \
  --project=example-project --region=asia-southeast1
```

## IAM boundary gate

Capture fresh policy readbacks into a new private directory. These are policy documents, not secret payloads.

```sh
mkdir -m 700 /tmp/lore-boundary-readback-r3
gcloud projects get-iam-policy example-project --format=json > /tmp/lore-boundary-readback-r3/lore-project-iam-readback.json
gcloud storage buckets get-iam-policy gs://example-lore-ledger --format=json > /tmp/lore-boundary-readback-r3/lore-ledger-iam-readback.json
gcloud storage buckets get-iam-policy gs://example-lore-artifacts --format=json > /tmp/lore-boundary-readback-r3/lore-artifact-iam-readback.json
gcloud run services get-iam-policy lore-worker --project=example-project --region=asia-southeast1 --format=json > /tmp/lore-boundary-readback-r3/lore-worker-final-policy.json
gcloud storage buckets describe gs://example-lore-artifacts --format=json > /tmp/lore-boundary-readback-r3/lore-artifact-bucket-readback.json
gcloud iam roles describe loreLedgerHead --project=example-project --format=json > /tmp/lore-boundary-readback-r3/loreLedgerHead-role-readback.json
gcloud iam roles describe loreLedgerNode --project=example-project --format=json > /tmp/lore-boundary-readback-r3/loreLedgerNode-role-readback.json
gcloud iam roles describe loreArtifactRead --project=example-project --format=json > /tmp/lore-boundary-readback-r3/loreArtifactRead-role-readback.json
gcloud iam roles describe loreArtifactWorker --project=example-project --format=json > /tmp/lore-boundary-readback-r3/loreArtifactWorker-role-readback.json
```

Read the nine service-account-accessible secret policies and the resource and service-account policies:

```sh
gcloud secrets get-iam-policy lore-app-database-url --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-app-database-url.json
gcloud secrets get-iam-policy lore-worker-database-url --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-worker-database-url.json
gcloud secrets get-iam-policy lore-migration-direct-url --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-migration-direct-url.json
gcloud secrets get-iam-policy lore-forget-hmac-key --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-forget-hmac-key.json
gcloud secrets get-iam-policy lore-portability-master-key --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-portability-master-key.json
gcloud secrets get-iam-policy lore-cursor-hmac-keys --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-cursor-hmac-keys.json
gcloud secrets get-iam-policy lore-identity-jdbc-url --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-identity-jdbc-url.json
gcloud secrets get-iam-policy lore-identity-db-password --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-identity-db-password.json
gcloud secrets get-iam-policy lore-identity-bootstrap-password --project=example-project --format=json > /tmp/lore-boundary-readback-r3/secret-lore-identity-bootstrap-password.json
gcloud tasks queues get-iam-policy lore-capture --project=example-project --location=asia-southeast1 --format=json > /tmp/lore-boundary-readback-r3/queue-iam.json
gcloud artifacts repositories get-iam-policy lore --project=example-project --location=asia-southeast1 --format=json > /tmp/lore-boundary-readback-r3/registry-iam.json
gcloud storage buckets get-iam-policy gs://example-lore-build-source --format=json > /tmp/lore-boundary-readback-r3/build-source-iam.json
gcloud iam service-accounts get-iam-policy lore-api@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-api-iam.json
gcloud iam service-accounts get-iam-policy lore-worker@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-worker-iam.json
gcloud iam service-accounts get-iam-policy lore-migration@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-migration-iam.json
gcloud iam service-accounts get-iam-policy lore-task-invoker@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-task-invoker-iam.json
gcloud iam service-accounts get-iam-policy lore-scheduler-invoker@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-scheduler-invoker-iam.json
gcloud iam service-accounts get-iam-policy lore-build@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-build-iam.json
gcloud iam service-accounts get-iam-policy lore-identity@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-identity-iam.json
gcloud iam service-accounts get-iam-policy lore-identity-bootstrap@example-project.iam.gserviceaccount.com --project=example-project --format=json > /tmp/lore-boundary-readback-r3/service-account-identity-bootstrap-iam.json
```

Combine the four custom-role descriptions into `lore-gcs-custom-role-readbacks.json` keyed by role ID; the nine secret policies into `lore-secret-iam-readbacks.json` keyed by secret name; the queue, registry, build-source and task-invoker policies into `lore-resource-iam-readbacks.json` keyed as `queue`, `registry`, `build-source` and `task-sa`; and the eight service-account policies into `lore-service-account-policy-readbacks.json` keyed by email. Keep the other five filenames exactly as declared in `iam-contract.json`. Then run the read-only gate:

```sh
npm run cloud:verify-boundaries -- --input-dir /tmp/lore-boundary-readback-r3
```

If the gate fails, stop before service replacement and reconcile only the reported role, member or condition. An existing secret or service-account policy without bindings may omit `bindings`; a missing file still fails.

## Identity setup

Build the identity images from the isolated context. Keycloak 26.8.1 and the Node proxy base are pinned by digest; the Keycloak target is built optimized with the resource-indicator feature.

```sh
docker build --target keycloak -t <registry>/identity-keycloak:<revision> infra/keycloak
docker build --target proxy -t <registry>/identity-proxy:<revision> infra/keycloak
```

For a first-time setup only, realm configuration, the user account and synthetic smoke principals are prepared with the private bootstrap Job (actions `configure`, `ensure-smoke-user`, `delete-smoke-user`) while the public identity service is stopped. The bootstrap creates the user with a temporary password and the `UPDATE_PASSWORD` and `CONFIGURE_TOTP` required actions only when the account has no password credential, and never resets an existing one. Keycloak generates subject IDs: pass the reported `user_subject_id` as `USER_SUBJECT_ID`, and `smoke_subject_id` as both `OAUTH_SMOKE_SUBJECT_ID` and `OAUTH_SMOKE_USER_ID`, to the database bootstrap. The database bootstrap creates or verifies the user, scope, principal and grant with the reserved IDs and records the exact realm URL as issuer; it does not run migrations.

The 2026-10-18 Lore cutover is already complete and must not be repeated. Its `lore-identity-bootstrap` Job renamed the realm, scopes, clients and account URL, but its final mapper-name readback failed because of a limitation in the pinned Keycloak API; do not report that Job as succeeded. The four mapper names were then corrected offline (`applied: 4`, `retry: 0`) with IDs and configuration preserved. A separate maintenance identity-verification Job passed the exact assertions and was deleted afterward. See the current [cloud verification register](../eval/cloud-verification.md) and [identity cutover record](identity-cutover.md). Do not run the setup commands below against the active Lore identity service.

```sh
node scripts/cloud-oauth-bootstrap.mjs configure
node scripts/cloud-oauth-bootstrap.mjs ensure-smoke-user
CLOUD_USER_BOOTSTRAP_ACTION=ensure-smoke node scripts/cloud-user-bootstrap.mjs
```

`OAUTH_SMOKE_CAPABILITIES` defaults to `read`; set it to `read,write,admin` before the user bootstrap only when a full acceptance run needs write or admin operations. After every smoke run, disable the synthetic app principal and remove its grant:

```sh
CLOUD_USER_BOOTSTRAP_ACTION=deactivate-smoke node scripts/cloud-user-bootstrap.mjs
```

Synthetic Keycloak users and the smoke client stay configured; re-enable their grants explicitly before a repeat run. The user account and grant are never touched by smoke tooling. Renaming the realm, clients and scopes in place follows [identity cutover](identity-cutover.md).

## Verification harnesses

Use disposable principals and scopes only. For the private API, set `CLOUD_API_IAM_TOKEN_FILE` to a mode-0600 file holding an operator Cloud Run ID token for the API audience; it is sent in `X-Serverless-Authorization` while the PKCE access token stays in `Authorization`.

**OAuth and MCP.** Identity mode checks discovery, JWKS, rejection of unknown resources, unregistered redirects, wrong verifiers and cross-resource code exchange, then a PKCE flow with exact audience, subject, scope ID and capability. Full mode adds REST Recall, MCP read Recall through the official SDK, the write tool list and audience isolation, without writing memory content.

```sh
npm run cloud:oauth:smoke
npm run cloud:oauth:smoke:full
```

**Cloud Tasks.** Provide `CLOUD_SMOKE_API_URL`, `CLOUD_SMOKE_WORKER_URL`, `CLOUD_SMOKE_SCHEDULER_JOB`, `CLOUD_SMOKE_USER_TOKEN`, `CLOUD_SMOKE_SCOPE_ID`, `CLOUD_API_IAM_TOKEN_FILE` and `CLOUD_SMOKE_WORKER_IAM_TOKEN_FILE` (an operator ID token for the worker audience). The smoke checks anonymous rejection, creates a synthetic capture, records two Scheduler dispatch acceptances, waits for a terminal state, then calls the worker sweep twice and confirms the state does not change. It does not inject hosted failures; forced failures are covered locally by `node scripts/local-recovery-smoke.mjs`.

```sh
node scripts/cloud-tasks-smoke.mjs
```

**Governance across users.** Requires two disposable synthetic principals and scopes with active grants, the API token file and the Scheduler resource. It exports, imports with `grant_imported_sources: true`, recalls in the destination and Forgets both copies. It writes real Forget entries to the target ledger; use a fresh destination every run.

```sh
npm run cloud:governance:smoke
```

**Cloud Storage ledger and artifacts.** Bootstrap an isolated verification namespace with a setup principal against a disposable, migrated, empty database, then run the smoke under the worker identity. Grant only the object actions needed on the derived `ledger/verification/<uuid>/` and `artifacts/verification/<uuid>/` prefixes and remove temporary bindings afterward.

```sh
CLOUD_STORAGE_SMOKE_ID='<fresh-uuid>' \
GCS_LEDGER_BUCKET='<ledger-bucket>' \
GCS_LEDGER_PREFIX='ledger/verification/<fresh-uuid>/' \
MIGRATION_DATABASE_URL='<disposable-empty-database-url>' \
CLOUD_STORAGE_SMOKE_TOKEN_FILE='<short-lived-setup-token-file>' \
npm run cloud:storage:bootstrap
```

```sh
CLOUD_STORAGE_SMOKE_ID='<same-fresh-uuid>' \
CLOUD_STORAGE_SMOKE_DATABASE_URL='<same-disposable-empty-database-url>' \
GCS_LEDGER_BUCKET='<ledger-bucket>' \
GCS_ARTIFACT_BUCKET='<artifact-bucket>' \
CLOUD_STORAGE_SMOKE_TOKEN_FILE='<short-lived-worker-token-file>' \
npm run cloud:storage:smoke
```

**Restore clone.** Uses the real GCS adapter with an isolated prefix and two disposable databases (a migration-ready source with no history and a distinct clone). Provide `CLOUD_RESTORE_SMOKE_ID` (new UUID), `CLOUD_RESTORE_SMOKE_MARKER` (private file under `/tmp`), `GCS_LEDGER_BUCKET`, `FORGET_HMAC_KEY` and the source admin, app and worker URLs. GCS access uses ADC, or a short-lived storage token in a mode-0600 file named by `CLOUD_RESTORE_SMOKE_TOKEN_FILE`. The runner checks that the admin, app and worker URLs of each database point to the same host and database and that source and clone differ; it never creates or drops databases and never uses the main database. Run `prepare` (it refuses a nonempty source or prefix), clone the source with the reviewed database procedure, run `forget` on the source, then add `CLOUD_RESTORE_CLONE_ADMIN_URL`, `CLOUD_RESTORE_CLONE_APP_URL` and `CLOUD_RESTORE_CLONE_WORKER_URL` and run `verify`. The clone must be rejected with an unapplied-ledger checkpoint mismatch, replay and purge, then become ready. This is not a managed Neon point-in-time recovery rehearsal.

```sh
npm run cloud:restore:smoke -- prepare
npm run cloud:restore:smoke -- forget
npm run cloud:restore:smoke -- verify
```

**Vertex provider.** Checks regional authentication, response-schema parsing, exact anchor validation and a 1,536-dimension embedding for one synthetic sentence, without writing data. Run it under the runtime identity, or with `CLOUD_PROVIDER_SMOKE_TOKEN_FILE` for a short-lived token that is deleted afterward.

```sh
CURATOR_PROVIDER=vertex \
VERTEX_PROJECT_ID=example-project \
VERTEX_LOCATION=asia-southeast1 \
node scripts/cloud-provider-smoke.mjs
```

**User sign-in diagnostic.** `npm run personal:login` is an optional local helper that checks the OIDC callback and user subject from the same computer through `http://127.0.0.1:18970/callback`. It is not the user's sign-in path and changes no cloud configuration.

Record results in the [cloud verification register](../eval/cloud-verification.md) without tokens, database URLs or source content.
