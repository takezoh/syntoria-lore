# Cloud Storage ledger and artifact verification — 2026-10-17

This dated record covers the Cloud Storage deletion ledger and export artifact adapters. Storage design is in [infrastructure](../technical/infrastructure.md#governance-storage); the bootstrap and smoke commands are in the [infrastructure runbook](../technical/infrastructure-runbook.md#verification-harnesses).

## Contract under test

`STORAGE_MODE=gcs` with ledger and artifact buckets selects Cloud Storage; otherwise local filesystem stores are used. The ledger is a chain of immutable node objects with a single head object updated by generation-conditioned compare-and-swap. A namespace is bootstrapped once by a setup principal after an empty-database check, which writes a sentinel that runtime identities never read or write. Cloud Storage authorizes `storage.objects.list` at bucket level, so it cannot be narrowed to a prefix by an IAM condition ([Cloud Storage IAM conditions](https://docs.cloud.google.com/storage/docs/access-control/iam?hl=en)); the worker holds it only on the dedicated artifact bucket. Local regressions for concurrency, retry, corruption, cleanup bounds, SDK preconditions and factory selection run with `npm run test:unit -- --testNamePattern='cloud deletion ledger|cloud portability|Google Cloud Storage|governance storage'`.

## Executed evidence

- Live validation on 2026-10-17 passed in isolated Singapore buckets with a disposable migrated PostgreSQL database. The worker smoke passed twice on the same UUID, advancing the ledger from sequence 4 to 6 on the second run; it wrote concurrent ledger entries and encrypted artifacts, verified same-request retry and same-claim idempotency, removed one claim without touching its siblings and then removed the remaining artifacts.
- API and worker IAM checks confirmed head compare-and-swap success, stale-generation rejection (HTTP 412) and rejection of ledger-node overwrite and delete (HTTP 403). Removing the head made initialize, current-head and snapshot reads fail closed; the setup bootstrap refused the existing sentinel, and the setup principal restored the verified sequence-4 head. These checks exercised real object generations, CRC-validated downloads, IAM and the configured region.

## Limits

The Cloud Storage SDK emitted repeated `MaxListenersExceededWarning` messages from `teeny-request` while downloading through Node's `pipeline`. The smoke completed and no memory leak was measured, but the warning's memory impact remains unproven; it is left visible rather than suppressed. The smoke does not establish production-scale latency, multi-instance fault behavior or retention policy.
