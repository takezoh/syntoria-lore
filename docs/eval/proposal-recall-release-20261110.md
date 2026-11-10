# Proposal recall production release — 2026-11-10

## Outcome

Source commit `246073f3046025cac2982df31b3a99a2a859930a` was pushed to `main`, built with Cloud Build and deployed to the existing Cloud Run API service. The new revision became ready and received 100% of traffic. The service account, environment and Secret references, ports, resources, concurrency and timeout were preserved.

The release makes saved AI proposals recallable with explicit authority, lifecycle, writer and revision source metadata, with an opt-out and user-authority priority on equal relevance. MCP writes accept structured source references and preserve them through corrections unless explicitly replaced. Usage guidance is returned by MCP initialization; no duplicate client-side prompt is required.

## Source and local verification

- The image was built from a 30-file allowlisted archive of the committed source, including the generated build configuration outside the repository. Local worktrees, build outputs, dependencies and private deployment configuration were excluded. The API license and attribution notice were included.
- Before committing, `npm run verify:local` passed on the reviewed source with Node.js 24 and a disposable loopback Firestore emulator using synthetic `demo-` project IDs: 29 unit tests and 61 emulator tests, plus build, typecheck, lint, formatting and secret scanning. Dependency audit passed its configured high-severity threshold; it reported 15 moderate advisories.
- [GitHub CI](https://github.com/takezoh/syntoria-lore/actions/runs/42784809516) passed for the source commit. Cloud Build succeeded.
- The deployment's exact image digest, build and revision identifiers are retained in ignored local operator evidence under `.local/cloud/releases/`, not in this repository's tracked files.

## Hosted observations

- `GET /readyz` returned 200.
- Protected-resource metadata returned 200 and matched the configured resource and Gate issuer.
- `POST /mcp` without credentials returned 401 with a resource-metadata authentication challenge.
- An existing authenticated connection successfully called `get_access` and query-only `recall_memories`, without a `scope_id` input.
- The recall returned 10 saved candidates, each labelled `authority: "proposal"`, with revision source-reference arrays. It reported no insufficiencies and an index watermark equal to the latest change, both 52. No memory text, source URI or personal identifier is copied into this record.

## Limits

These observations establish readiness, the authentication boundary and one authenticated read path, including retrieval of existing proposals. They do not establish semantic recall quality, latency or load behavior, every access-control scenario, hosted source writes, correction, Forget or authenticated MCP initialization metadata. The restored initialization instructions and those write contracts were checked locally.

No memory writes, source backfill, admission changes or approval-policy changes were performed as release verification. Existing memories did not acquire external source references automatically. Client integrations that cached older tool schemas may need to refresh those definitions.
