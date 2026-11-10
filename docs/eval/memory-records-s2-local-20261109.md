# Memory Records step 2 local verification — 2026-11-09

This record covers units S2-1 to S2-3b of the [Memory Records design](../design/memory-records.md): the isolated `packages/memory-records` package with the Memory Record value model, the Firestore repository, Forget and restore, baseline A capture and derived recall. It is local evidence only. The package is not wired into REST, MCP or the worker, nothing was deployed, and no real model, source provider or Firestore project was used.

## Method

Each unit ran through a dev-skills implementation loop: one agent implemented the unit against the accepted design and an independent agent reviewed it until it approved. The main session then reran every check on a separate clean worktree holding an exact copy of the approved files before copying them into the checkout.

| Item | Setting |
| --- | --- |
| Runtime | Node.js 24 through mise, as `.node-version` requires |
| Firestore | Local emulator from the gcloud `cloud-firestore-emulator` component on Java 25, on a free loopback port per run; synthetic `demo-` project IDs |
| PostgreSQL | A disposable container from the CI image `pgvector/pgvector@sha256:ac08538c…`, published on the loopback interface, bootstrapped with `scripts/local-bootstrap.mjs`; the integration database was dropped, recreated and migrated before each `verify:local` run, as in CI |
| Credentials | Synthetic local values from `.github/workflows/local-contract.yml`; the application and worker passwords were lengthened to meet the 24-character minimum |

## Results

Final checks on the approved S2-3b state, which contains all earlier units:

| Check | Result |
| --- | --- |
| `npm run verify:local` | Exit 0: build, migrations twice, typecheck, lint, format, unit (17 files, 105 tests), PostgreSQL integration (55 tests), restore clone, fresh-database portability, user-identity and subject-admission migration scripts, OpenAPI check, secret scan and `npm audit --audit-level=high` |
| `npm run test:firestore` | 2 files, 50 tests passed, none skipped |
| `npm run test:firestore` without `FIRESTORE_EMULATOR_HOST` | Fails with a message that the emulator is required |
| `npm ci` with the new lockfile | Passed |
| `git diff --check` | Passed |

Each earlier unit passed the same checks when it was accepted.

## Defects found and closed before acceptance

Independent reviews and the main session found these defects in candidates; each was fixed and covered by an emulator or unit test before its unit was accepted:

- The commit path authorized changes to existing records from the submitted revision instead of the stored record. A connection allowed only General could rewrite a compartment-labelled record, and an AI connection could overwrite a user's active decision by claiming AI attribution. An automated security review flagged this after S2-2a was accepted; it was fixed in S2-2b.
- Validation accepted unknown keys that could carry original source text, and selectors returned unapproved candidates.
- History reads accepted gapped or out-of-order revision series, and missed or misread identity and path mismatches; the same checks were later added to recall.
- A batch rejected non-overlapping decisions for the same question.
- Capture took compartment labels and attribution from model output, left malformed extractor output in `processing`, persisted an exception name that could carry source text, and committed prepared changes after consent was withdrawn.
- Recall failed the whole query when one candidate cited a revoked source, and could not find content that existed only in an earlier revision.

## Observations and limits

- A shared integration database reused across many runs made one existing PostgreSQL test fail: unindexed scopes from earlier runs crowded the maintenance sweep's actor limit, so `reindexed` stayed 0. The test passed on a freshly created database, which is what CI uses. The code under test is unchanged by this work.
- `npm audit` reports 15 moderate advisories and none high. Ten existed before this work; five arrive through `@google-cloud/firestore` (`gaxios`, `gcp-metadata`, `google-gax` and their `glob`/`rimraf` chain).
- The emulator does not show managed IAM, real transaction contention, latency, cost, restore of a managed database or Firestore vector search. Recall computes vector similarity in memory over at most 1,000 index entries per scope and reports when it hits that limit.
- The deletion ledger is a port with a deterministic test implementation; no production adapter exists.
- Capture stores AI proposals as held candidates; automatic activation of facts is not implemented.
- Deterministic embedding and extractor doubles exercise contracts only. Extraction quality and semantic recall quality were not measured.
- CI does not run the Firestore suite.
