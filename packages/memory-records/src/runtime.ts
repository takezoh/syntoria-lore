import { MemoryAccess } from './access.js';
import { createFirestoreClient } from './firestore-client.js';
import {
  createFirestoreDeletionLedger,
  type FirestoreDeletionLedger,
} from './firestore-deletion-ledger.js';
import { FirestoreObservationLedger } from './firestore-observation-ledger.js';
import type { FirestoreMemoryRecordRepository } from './firestore-repository.js';

export interface MemoryRecordsRuntimeOptions {
  readonly projectId: string;
  /** The Memory Records database. */
  readonly databaseId: string;
  /** The separate database that holds only the deletion ledger. */
  readonly ledgerDatabaseId: string;
  readonly cursorSecret: Uint8Array;
}

export interface MemoryRecordsRuntime {
  /** The Memory Records repository; the same object as `observations`. */
  readonly repository: FirestoreMemoryRecordRepository;
  readonly observations: FirestoreObservationLedger;
  readonly ledger: FirestoreDeletionLedger;
  readonly access: MemoryAccess;
  /** Fails unless both databases answer a read. */
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

/** Wires the repository, access and deletion ledger over their two Firestore databases. */
export function createMemoryRecordsRuntime(
  options: MemoryRecordsRuntimeOptions,
): MemoryRecordsRuntime {
  if (options.databaseId === options.ledgerDatabaseId) {
    throw new TypeError('The deletion ledger needs its own database');
  }
  const ledger = createFirestoreDeletionLedger({
    projectId: options.projectId,
    databaseId: options.ledgerDatabaseId,
  });
  const firestore = createFirestoreClient({
    projectId: options.projectId,
    databaseId: options.databaseId,
  });
  const repository = new FirestoreObservationLedger(firestore, options.cursorSecret, ledger);
  const access = new MemoryAccess(firestore, repository);
  return {
    repository,
    observations: repository,
    ledger,
    access,
    async checkReady() {
      await Promise.all([repository.checkAvailable(), ledger.checkAvailable()]);
    },
    async close() {
      await Promise.all([repository.close(), ledger.close()]);
    },
  };
}
