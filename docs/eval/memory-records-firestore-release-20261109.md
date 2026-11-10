# Firestore Lore first production release — 2026-11-09

## Outcome

The first Firestore version of Lore, `apps/api` with Remote MCP over `packages/memory-records`, was deployed to Cloud Run as `lore-api` on 2026-11-09 and passed anonymous readiness and authentication-boundary checks on the public origin. No authenticated MCP operation has run in production yet, so remembering and recalling through a real AI client, Vertex AI embeddings and recall quality are unverified.

## Source and artifacts

- The source was the working tree of 2026-11-09, committed after deployment as `f480e2f`: the PostgreSQL implementation removed, `packages/memory-records`, `apps/api` and `scripts/admit-subject.mjs` added. The uploaded build source matches the build-context files of `f480e2f` except the generated `cloudbuild.yaml` and an empty local `.claude` directory that held no files; build contexts now exclude such directories.
- The image lacks the Apache License copy and notice for the adapted Gate verifier, which `c560816` restored in `apps/api`; the next image includes them.
- Before the build, `npm run verify:local` passed on a clean copy of that tree: unit tests (4 files, 28 tests), the Firestore emulator suite (3 files, 57 tests), secret scan and dependency audit with 15 moderate and no high advisories. The first emulator run hit a 5-second timeout in the existing stale compare-and-set test; three reruns passed.
- Cloud Build `d9907f4e-7012-4a23-bb1a-ffc24bb09b40` built the image from an allowlisted context of 28 files (package manifests, TypeScript configuration, Dockerfile, `apps/` and `packages/`), digest `sha256:786430b31e2ccc855a67a440626980adbb006cebba98382976baf3adf2e3ca26`. The image runs as the non-root `node` user without development dependencies.

## Rollout

1. Two Firestore Native databases were created in `asia-southeast1` with deletion protection: `lore-memory-records`, with point-in-time recovery, and `lore-deletion-ledger`, the independent deletion ledger. Single-field indexing was disabled for `searchIndex` `embedding.values`.
2. The API service account was granted `roles/datastore.user` with an IAM condition that names only those two databases.
3. The owner's Gate subject was admitted with `scripts/admit-subject.mjs` under the `automatic` approval policy.
4. Revision `lore-api-00001-smv` took 100% of traffic, publicly invocable as before; data operations still need a Gate bearer token for the exact `/mcp` audience. It reads the existing Gate MCP resource credential and cursor key ring from Secret Manager.

## Hosted checks

On the public origin (shown here as `https://lore-api.example.com`):

- `GET /readyz` returned 503 for about two minutes after the IAM grant, then 200 from 14:58:05 UTC: both databases answer the service account.
- `GET /.well-known/oauth-protected-resource/mcp` returned 200 with the `/mcp` resource and Gate as the authorization server.
- `POST /mcp` without a credential returned 401 with a `resource_metadata` bearer challenge.
- `GET /healthz` returned Google's front-end 404 and never reached the service; Cloud Run reserves that path, so liveness is checked through `/readyz`.

## Limits

- No authenticated MCP call, Gate introspection with the production resource credential, Vertex AI embedding, remember, recall, correction or Forget has run in production.
- Indexing, purge and restore reconciliation run inside the API after each write; there is no separate worker, and the paused worker schedule was not resumed.
- AI proposals saved without `as_user` are not returned by recall; person confirmation at Gate, the REST adapter and compartment widening are not available.
- Latency, cost, managed restore and recall quality have not been measured.

## Rollback

There is no earlier Firestore revision. To withdraw the service, stop traffic or delete the `lore-api` service; the databases keep their deletion protection. The PostgreSQL deployment no longer exists, so there is nothing to return to.
