# Source provenance migration — 2026-11-10

## Result

The operator migrated all 51 existing Memory Record heads, adding 55 Google Drive source references covering 43 distinct URIs. An LLM reviewed every record's assertion, details and revision reasons before an explicit per-record plan was materialized. Exact stored spans support each migrated metadata field; the executor does not interpret prose. Original source documents were not fetched or independently verified.

The migration retained statements, qualifications, attribution, proposal authority, candidate lifecycle and approval provenance. Missing optional source metadata was omitted. Five confidential references retained that marker. Production identifiers, source content, the private snapshot and the executable manifest remain outside the repository.

## Hosted verification

- The authenticated IAM operator's read-only dry-run matched all 51 heads and their historical/index baselines before the atomic apply.
- Apply and verify succeeded. Reapplying the same manifest reported a replay with no additional revision or sequence advancement.
- An independent readback checked all 51 heads and all additions against the reviewed plan, including unchanged assertion fields, writers and approvals.
- All 52 pre-existing immutable revisions and 52 pre-existing search indexes retained identical data and Firestore update timestamps. There are now 103 revisions and 103 indexes.
- Current revisions contain 107 source references: 52 retained request references and 55 external references. The additions contain 49 titles, 50 versions and one locator; absent fields were not invented.
- The scope sequence and index watermark are both 53. One immutable migration audit and receipt record the metadata editor separately from the original assertion writers. The deletion ledger remained unchanged.
- Authenticated MCP recall returned ten proposal items, all carrying external source references, with both sequence and watermark at 53. A get-memory read returned candidate/proposal authority, its new revision and its earlier history, with no withheld revisions.

This is a metadata migration observation, not a measurement of extraction or recall quality. Existing MCP source support serves the migrated data without a service deployment.

## Local verification and review

`npm run verify:local` passed build, typecheck, lint, formatting, 34 unit tests, 65 Firestore emulator tests, secret scanning and the configured high-severity dependency audit threshold. The audit reported 15 moderate advisories. Tests use synthetic emulator projects. Independent review required and verified strict tokeninfo identity normalization and a migration timestamp later than every existing revision, including zero-write rejection of stale timestamps.

The development-loop `implementation` profile completed with `SUCCEEDED`; loop `402eb5c72a5dee3813135c5d6b1f6eceadaef51ed7b62b05686e616660f68f4e`, ledger head `c487e356d65806feb3f1481a4e3903de4c8a539cb725972daabd255170171544`.
