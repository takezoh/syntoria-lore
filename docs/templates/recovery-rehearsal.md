# Recovery rehearsal record

Copy this file into a dated record under [docs/eval](../eval/) for each restore rehearsal, and complete every applicable item. The procedure is in [deployment](../technical/deployment.md#rollback-and-recovery).

- Date and operator:
- Environment and scope (local/CI/staging/production):
- Recovery trigger and target snapshot:
- Independent deletion-ledger HEAD before restore:
- Database checkpoint before reconciliation:
- Explicit reconciliation command:
- Replayed, purged, and rejected record counts:
- Readiness result:
- Protected read denied before reconciliation succeeded:
- Forgotten memory/version/evidence/link/source/artifact checks:
- Unrelated-scope continuity check:
- Failure injection (missing, corrupt, or gapped ledger) and fail-closed result:
- Data-loss or duplication result:
- Measured duration and limitations:
- Follow-up actions and users:

## Rehearsal checklist

- [ ] Restore the database snapshot into an isolated environment.
- [ ] Verify the independent deletion-ledger head and database checkpoint.
- [ ] Confirm protected reads remain unavailable before explicit reconciliation.
- [ ] Run the documented reconcile command and record its result.
- [ ] Verify forgotten content cannot be read or reintroduced.
- [ ] Verify unrelated scopes remain available and unchanged.
- [ ] Exercise a missing, corrupt, or gapped ledger and confirm fail-closed behavior.
- [ ] Record duration, limitations, and any corrective actions.
