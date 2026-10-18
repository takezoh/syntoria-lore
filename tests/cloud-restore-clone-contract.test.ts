import { describe, expect, it } from 'vitest';
import { isExpectedRestoreCheckpointMismatch } from '../scripts/cloud-restore-clone-contract.js';

describe('cloud restore clone readiness contract', () => {
  it('accepts only the expected unapplied-ledger checkpoint mismatch as fail-closed evidence', () => {
    expect(
      isExpectedRestoreCheckpointMismatch(
        new Error(
          'Restore readiness blocked: the verified deletion ledger suppressions are not applied',
        ),
      ),
    ).toBe(true);
    expect(
      isExpectedRestoreCheckpointMismatch(
        new Error(
          'Restore readiness blocked: the verified deletion ledger changed during readiness check',
        ),
      ),
    ).toBe(false);
    expect(isExpectedRestoreCheckpointMismatch(new Error('temporary GCS read failure'))).toBe(
      false,
    );
    expect(isExpectedRestoreCheckpointMismatch(new Error('temporary database read failure'))).toBe(
      false,
    );
    expect(isExpectedRestoreCheckpointMismatch('checkpoint mismatch')).toBe(false);
  });
});
