# Container and Cloud Build source packaging — 2026-10-17

## Observed failure

The parent’s standalone Docker Compose quality run used an image built earlier on 2026-10-17 and failed 2 suites and 6 tests, with 53 passing. The missing files caused OAuth proxy imports and cloud deployment manifest reads to fail. The Docker build omitted `infra/` and `docs/eval/cloud-oauth.md`, and the broad `**/*secret*` rules excluded `scripts/secret-scan.mjs`, which `npm run verify:local` invokes. The immutable Cloud Build context omitted the Keycloak proxy and IAM contract. Its source-context regression did not assert the Dockerfile, ignore metadata, complete source closure, or generation metadata.

## Packaging repair

The Docker quality image now copies the complete `infra/` tree, the OAuth evaluation document, and its packaging metadata. The Cloud Build snapshot allowlist includes `infra/cloud/`, `infra/keycloak/`, and that evaluation document while retaining the existing environment, credential, key, log, cache, and incremental compiler-state exclusions. The exact `scripts/secret-scan.mjs` path is the sole exception for secret-named files in the Docker, gcloud, and snapshot policy. The snapshot policy excludes any other path with a secret or credential substring in any component, matching the broad Docker/gcloud rules. Its generator regression uses an isolated temporary source tree and confirms embedded secret filenames and nested secret/credential directories are absent, without writing to the repository or immutable snapshot. The offline regression checks required snapshot assets, manifest hashes and sizes, and excluded credential/compiler-state examples.

## Verification state

Host-only packaging checks passed on 2026-10-17: `npm test -- tests/cloud-deploy.test.ts tests/container-packaging.test.ts` passed 2 files and 12 tests; targeted Prettier and ESLint checks passed for the changed source and test files. These checks exercise Dockerfile dependency closure, generated source-snapshot contents and metadata, required-file hashes/sizes, and the exact scanner exception while retaining credential, environment, key/log/cache/temp, and compiler-state exclusions.

The parent’s full Compose quality rerun passed on 2026-10-17: unit tests 86/86, PostgreSQL integration 28/28, restore-clone replay/purge/readiness, fresh-database import, build, typecheck, lint, format, OpenAPI, secret scan, and high-severity audit all passed. The local quality image digest was `sha256:7b763dd0c8b9cd7e88ab886702a38d1265ada22b9bbb4b54d7c8ac22219555e7`. This full run preceded the final secret/credential path-policy and isolated-fixture regression adjustment; application runtime code did not change.

After that adjustment, the parent regenerated the final 178-file sanitized context. All 178 manifest entries matched the current repository; manifest digest: `sha256:11b6bd65f9053f6400ff420919b0bd49361d4e7f439081f3daa8384ce74ce5d4`. The Docker build passed with image digest `sha256:4c7d55ddcb631e2b8b1fd36a1da4b5b499ce0f5d8aedfb5cd4edee79c6173abd`; network-disabled unit tests passed 87/87 across 12 files. PostgreSQL integration and the full Compose command were not rerun after this packaging/test-only adjustment. Final rerun evidence is `/tmp/thymesis-final-sanitized-build-r3.log`, `/tmp/thymesis-final-sanitized-unit-r3.log`, and `/tmp/thymesis-packaging-rerun-result.json`.

These results close local packaging and image verification. A new hosted Cloud Build and deployment of this repaired packaging snapshot have not been run; prior r2 service, migration, and readiness observations remain valid historical evidence.
