const EXPECTED_CHECKPOINT_MISMATCH =
  'Restore readiness blocked: the verified deletion ledger suppressions are not applied';

export function isExpectedRestoreCheckpointMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === EXPECTED_CHECKPOINT_MISMATCH;
}
