import { randomUUID } from 'node:crypto';
import {
  canonicalDeletionLedgerJson,
  emptyDeletionLedgerHash,
  hashDeletionLedgerEntry,
  isDeletionLedgerHead,
  parseStoredDeletionLedgerEntry,
  validateDeletionLedgerEntry,
  type DeletionLedger,
  type DeletionLedgerEntry,
  type DeletionLedgerReceipt,
  type DeletionLedgerSnapshot,
  type LedgerHead,
  type StoredEntry,
} from './deletion-ledger.js';
import {
  type CloudObjectBucket,
  isCloudObjectPreconditionFailed,
  normalizeCloudObjectPrefix,
} from './cloud-object-bucket.js';

const defaultPrefix = 'ledger/';

export interface CloudDeletionLedgerOptions {
  readonly prefix?: string;
  readonly maxCasAttempts?: number;
}

export class CloudDeletionLedger implements DeletionLedger {
  private readonly prefix: string;
  private readonly maxCasAttempts: number;

  constructor(
    private readonly bucket: CloudObjectBucket,
    options: CloudDeletionLedgerOptions = {},
  ) {
    this.prefix = normalizeCloudObjectPrefix(options.prefix ?? defaultPrefix, 'GCS_LEDGER_PREFIX');
    this.maxCasAttempts = options.maxCasAttempts ?? 8;
    if (
      !Number.isSafeInteger(this.maxCasAttempts) ||
      this.maxCasAttempts < 1 ||
      this.maxCasAttempts > 32
    ) {
      throw new Error('Deletion ledger CAS attempts must be between 1 and 32');
    }
  }

  async initialize(): Promise<void> {
    await this.readSnapshot();
  }

  async append(entry: DeletionLedgerEntry): Promise<DeletionLedgerReceipt> {
    validateDeletionLedgerEntry(entry);
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const observed = await this.readHead();
      const chain = await this.verifyChain(observed.head);
      const previous = chain.find((stored) => stored.entry.request_id === entry.request_id);
      if (previous !== undefined) {
        this.assertSameRequest(previous, entry);
        return receiptFor(previous);
      }

      const stored: StoredEntry = {
        sequence: observed.head.sequence + 1,
        previous_hash: observed.head.entry_hash,
        entry_hash: hashDeletionLedgerEntry(observed.head.entry_hash, entry),
        entry,
      };
      const nodeName = this.nodeName(stored.entry_hash);
      await this.createNode(nodeName, stored);

      const nextHead: LedgerHead = {
        version: 1,
        sequence: stored.sequence,
        entry_hash: stored.entry_hash,
        generation: stored.entry_hash,
      };
      try {
        await this.bucket.put(
          this.headName(),
          Buffer.from(canonicalDeletionLedgerJson(nextHead)),
          observed.objectGeneration,
        );
        return receiptFor(stored);
      } catch (error) {
        if (isCloudObjectPreconditionFailed(error)) continue;

        // A timed-out upload can have committed before its response was lost. Resolve that
        // ambiguity from the durable chain before returning an error to the caller.
        const latest = await this.readSnapshot();
        const committed = latest.entries.find((item) => item.entry.request_id === entry.request_id);
        if (committed !== undefined) {
          this.assertSameRequest(committed, entry);
          return receiptFor(committed);
        }
        if (latest.head.head_generation !== observed.head.generation) continue;
        throw new Error('Unable to confirm the deletion ledger HEAD update', { cause: error });
      }
    }
    throw new Error('Deletion ledger HEAD changed too often; retry the request');
  }

  async readVerified(): Promise<readonly StoredEntry[]> {
    return (await this.readSnapshot()).entries;
  }

  async readSnapshot(): Promise<DeletionLedgerSnapshot> {
    const observed = await this.readHead();
    const entries = await this.verifyChain(observed.head);
    return {
      entries,
      head: {
        sequence: observed.head.sequence,
        entry_hash: observed.head.entry_hash,
        head_generation: observed.head.generation,
      },
    };
  }

  async currentHead(): Promise<DeletionLedgerReceipt> {
    return (await this.readSnapshot()).head;
  }

  /** Explicit bootstrap for a new namespace after the caller verifies an empty database. */
  async bootstrapEmpty(databaseHasHistory: boolean): Promise<DeletionLedgerReceipt> {
    if (databaseHasHistory) {
      throw new Error('Cannot bootstrap an empty deletion ledger for a database with history');
    }
    const [head, sentinel, nodes] = await Promise.all([
      this.bucket.get(this.headName()),
      this.bucket.get(this.sentinelName()),
      this.bucket.list(this.nodePrefix(), null, 1),
    ]);
    if (head !== null || sentinel !== null || nodes.names.length !== 0) {
      throw new Error('Deletion ledger namespace is not new and empty');
    }

    const bootstrapId = randomUUID();
    const sentinelBody = {
      version: 1,
      bootstrap_id: bootstrapId,
      created_at: new Date().toISOString(),
    };
    await this.bucket.put(
      this.sentinelName(),
      Buffer.from(canonicalDeletionLedgerJson(sentinelBody)),
      '0',
    );
    const headBody: LedgerHead = {
      version: 1,
      sequence: 0,
      entry_hash: emptyDeletionLedgerHash,
      generation: bootstrapId,
    };
    await this.bucket.put(this.headName(), Buffer.from(canonicalDeletionLedgerJson(headBody)), '0');
    return {
      sequence: 0,
      entry_hash: emptyDeletionLedgerHash,
      head_generation: bootstrapId,
    };
  }

  private async readHead(): Promise<{ head: LedgerHead; objectGeneration: string }> {
    const object = await this.bucket.get(this.headName());
    if (object === null) throw new Error('Deletion ledger HEAD is missing');
    let value: unknown;
    try {
      value = JSON.parse(object.body.toString('utf8'));
    } catch (error) {
      throw new Error('Deletion ledger HEAD is invalid', { cause: error });
    }
    if (
      !isDeletionLedgerHead(value) ||
      value.sequence < 0 ||
      (value.sequence === 0 && value.entry_hash !== emptyDeletionLedgerHash) ||
      (value.sequence === 0 && !isUuid(value.generation)) ||
      (value.sequence > 0 && value.generation !== value.entry_hash) ||
      !/^[1-9][0-9]*$/.test(object.generation)
    ) {
      throw new Error('Deletion ledger HEAD is invalid');
    }
    return { head: value, objectGeneration: object.generation };
  }

  private async verifyChain(head: LedgerHead): Promise<StoredEntry[]> {
    if (head.sequence === 0) return [];
    let expectedHash = head.entry_hash;
    const newestFirst: StoredEntry[] = [];
    for (let sequence = head.sequence; sequence >= 1; sequence -= 1) {
      const object = await this.bucket.get(this.nodeName(expectedHash));
      if (object === null) throw new Error('Deletion ledger is incomplete or stale');
      let stored: StoredEntry;
      try {
        stored = parseStoredDeletionLedgerEntry(object.body.toString('utf8'));
      } catch (error) {
        throw new Error('Deletion ledger entry is invalid', { cause: error });
      }
      if (
        stored.sequence !== sequence ||
        stored.entry_hash !== expectedHash ||
        stored.entry_hash !== hashDeletionLedgerEntry(stored.previous_hash, stored.entry)
      ) {
        throw new Error('Deletion ledger hash chain is corrupt');
      }
      newestFirst.push(stored);
      expectedHash = stored.previous_hash;
    }
    if (expectedHash !== emptyDeletionLedgerHash) {
      throw new Error('Deletion ledger hash chain does not reach the empty head');
    }
    return newestFirst.reverse();
  }

  private async createNode(name: string, stored: StoredEntry): Promise<void> {
    const body = Buffer.from(canonicalDeletionLedgerJson(stored));
    try {
      await this.bucket.put(name, body, '0');
    } catch (error) {
      const existing = await this.bucket.get(name);
      if (existing !== null && existing.body.equals(body)) return;
      if (isCloudObjectPreconditionFailed(error)) {
        throw new Error('Deletion ledger immutable node has conflicting contents', {
          cause: error,
        });
      }
      if (existing !== null) {
        throw new Error('Deletion ledger immutable node has conflicting contents', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private assertSameRequest(stored: StoredEntry, entry: DeletionLedgerEntry): void {
    if (canonicalDeletionLedgerJson(stored.entry) !== canonicalDeletionLedgerJson(entry)) {
      throw new Error('Deletion ledger request id has different contents');
    }
  }

  private headName(): string {
    return `${this.prefix}HEAD.json`;
  }

  private sentinelName(): string {
    return `${this.prefix}BOOTSTRAP.json`;
  }

  private nodePrefix(): string {
    return `${this.prefix}objects/`;
  }

  private nodeName(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Deletion ledger entry hash is invalid');
    return `${this.nodePrefix()}${hash}.json`;
  }
}

function receiptFor(stored: StoredEntry): DeletionLedgerReceipt {
  return {
    sequence: stored.sequence,
    entry_hash: stored.entry_hash,
    head_generation: stored.entry_hash,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
