# Migration review record

Copy this file into the migration change or review record and complete each applicable item.

- Migration file / version:
- Contract, requirement, or incident:
- Owner and reviewer:
- Forward-only deployment order:
- Existing rows and expected data volume:
- Lock, table rewrite, and index-build behavior:
- Backfill batching, checkpoints, restart, and forward-repair procedure:
- RLS, grants, worker permissions, and tenant-isolation impact:
- Read/write compatibility while old and new application versions overlap:
- Forget, source-rights, export, and restore-ledger impact:
- Verification commands and observed results:
- Operational signals and stop condition:

## Review checklist

- [ ] The migration is additive or otherwise forward-only; no applied migration is edited.
- [ ] Constraints and indexes can be deployed safely for the expected data volume.
- [ ] Backfills are bounded, resumable, and safe to retry.
- [ ] Application roles retain only the required grants and RLS behavior.
- [ ] Mixed-version operation has a defined order and compatibility window.
- [ ] Forget, export/import, and restore behavior account for the changed data.
- [ ] Failure can be repaired by a documented forward action.
- [ ] The listed checks ran against a disposable database and their results are attached.
