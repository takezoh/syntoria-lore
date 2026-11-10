import { createHash } from 'node:crypto';
import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import { createFirestoreClient } from './firestore-client.js';
import type {
  DeletionLedger,
  DeletionLedgerEntry,
  DeletionLedgerSnapshot,
} from './firestore-repository.js';

const STATE_COLLECTION = 'deletionLedgerState';
const ENTRY_COLLECTION = 'deletionLedgerEntries';
const INDEX_COLLECTION = 'deletionLedgerIndex';

function valid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1024;
}

function validEntry(value: unknown): value is DeletionLedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    valid(entry['id']) &&
    valid(entry['tenantId']) &&
    valid(entry['scopeId']) &&
    valid(entry['recordId'])
  );
}

function validHead(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The deletion ledger on its own Firestore database. Entries are append-only: each append
 * creates a new entry at the next position and moves the head in one transaction, and an entry
 * is never overwritten. Appending an entry ID again is a no-op, so a retry after a lost response
 * does not add a second entry.
 */
export class FirestoreDeletionLedger implements DeletionLedger {
  constructor(private readonly firestore: Firestore) {}

  async append(entry: DeletionLedgerEntry): Promise<void> {
    if (!validEntry(entry)) throw new TypeError('Invalid deletion ledger entry');
    const record = {
      id: entry.id,
      tenantId: entry.tenantId,
      scopeId: entry.scopeId,
      recordId: entry.recordId,
    };
    await this.firestore.runTransaction(async (transaction) => {
      const [index, state] = await Promise.all([
        transaction.get(this.indexRef(entry.id)),
        transaction.get(this.headRef()),
      ]);
      if (index.exists) {
        const stored = index.data() as Partial<DeletionLedgerEntry>;
        if (
          stored.id !== record.id ||
          stored.tenantId !== record.tenantId ||
          stored.scopeId !== record.scopeId ||
          stored.recordId !== record.recordId
        ) {
          throw new Error('A deletion ledger entry ID was reused for a different entry');
        }
        return;
      }
      const head: unknown = state.exists ? state.get('head') : 0;
      if (!validHead(head)) throw new Error('Deletion ledger head is invalid');
      const position = head + 1;
      const appendedAt = new Date().toISOString();
      transaction.create(this.entryRef(position), { ...record, position, appendedAt });
      transaction.create(this.indexRef(entry.id), { ...record, position });
      transaction.set(this.headRef(), { head: position, updatedAt: appendedAt });
    });
  }

  async includes(entryId: string): Promise<boolean> {
    if (!valid(entryId)) return false;
    const index = await this.indexRef(entryId).get();
    return index.exists && index.get('id') === entryId;
  }

  async head(): Promise<number> {
    const state = await this.headRef().get();
    const head: unknown = state.exists ? state.get('head') : 0;
    if (!validHead(head)) throw new Error('Deletion ledger head is invalid');
    return head;
  }

  async snapshot(): Promise<DeletionLedgerSnapshot> {
    return this.firestore.runTransaction(
      async (transaction) => {
        const state = await transaction.get(this.headRef());
        const head: unknown = state.exists ? state.get('head') : 0;
        if (!validHead(head)) throw new Error('Deletion ledger head is invalid');
        const page = await transaction.get(
          this.firestore
            .collection(ENTRY_COLLECTION)
            .where('position', '<=', head)
            .orderBy('position'),
        );
        const entries: DeletionLedgerEntry[] = [];
        page.docs.forEach((document, index) => {
          const value: unknown = document.data();
          if (!validEntry(value) || document.get('position') !== index + 1) {
            throw new Error('Deletion ledger entries are incomplete or invalid');
          }
          entries.push({
            id: value.id,
            tenantId: value.tenantId,
            scopeId: value.scopeId,
            recordId: value.recordId,
          });
        });
        if (entries.length !== head) throw new Error('Deletion ledger entries are incomplete');
        return { head, entries };
      },
      { readOnly: true },
    );
  }

  /** A cheap read that fails when the ledger database cannot be reached. */
  async checkAvailable(): Promise<void> {
    await this.headRef().get();
  }

  async close(): Promise<void> {
    await this.firestore.terminate();
  }

  private headRef(): DocumentReference {
    return this.firestore.collection(STATE_COLLECTION).doc('head');
  }

  private entryRef(position: number): DocumentReference {
    return this.firestore.collection(ENTRY_COLLECTION).doc(String(position).padStart(16, '0'));
  }

  private indexRef(entryId: string): DocumentReference {
    return this.firestore
      .collection(INDEX_COLLECTION)
      .doc(createHash('sha256').update(entryId, 'utf8').digest('hex'));
  }
}

export function createFirestoreDeletionLedger(options: {
  readonly projectId: string;
  readonly databaseId: string;
}): FirestoreDeletionLedger {
  if (!valid(options.projectId) || !valid(options.databaseId)) {
    throw new TypeError('The deletion ledger needs a project and its own database ID');
  }
  return new FirestoreDeletionLedger(
    createFirestoreClient({ projectId: options.projectId, databaseId: options.databaseId }),
  );
}
