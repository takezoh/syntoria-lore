# Situational recall local verification, 2026-11-12

## Scope

Verified the working-tree changes to contextual rank fusion, matched historical evidence, intent-aware MCP input, bounded vector candidate recovery and exhaustion diagnostics, process-local index retries, and the retrieval evaluation scorer. This record establishes local behavior only.

## Observed results

With FIRESTORE_EMULATOR_HOST set to 127.0.0.1:8085, npm run verify:local exited successfully: build, typecheck, lint, formatting, 56 unit tests, 70 Firestore emulator tests, secret scan and dependency audit at the high threshold. The audit reported 15 moderate findings; these were not remediated in this change.

The new recovery regression fails embedding generation for a committed observation, restores the provider, and checks that indexing completes without another observation write. The test uses deterministic embeddings and a running API process. The scorer regression checks missing-case rejection and prohibited evidence beyond top_k, including the case where recall is perfect but disclosure fails.

The fixture validator accepted 22 observation seeds and 14 retrieval cases. Local file links and git diff --check passed.

## Limits

No semantic-quality score is claimed. The full fixture corpus has not been loaded into a controlled live evaluation environment. Real embeddings, managed vector indexes, scale, billing, hosted client behavior and independent held-out questions have not been evaluated. The read-only runner requires a prepared fixture-ID mapping and controlled lifecycle/permission setup. It does not seed or grant identities.

Maintenance tracks authenticated scopes in memory and retries their durable queues with backoff. It cannot execute while its process is stopped or CPU-suspended, and after restart it needs an authenticated operation to activate a scope. External scheduled recovery remains outstanding. No release or deployment was performed.
