import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DeletionLedgerEntry {
  readonly request_id: string;
  readonly owner_id: string;
  readonly scope_id: string;
  readonly principal_id: string;
  readonly actor_kind: 'owner';
  readonly target_memory_ids: readonly string[];
  readonly target_source_ids: readonly string[];
  readonly target_subject_ids: readonly string[];
  readonly source_locator_hmacs: readonly string[];
  readonly blocked_at: string;
}

export interface DeletionLedgerReceipt {
  readonly sequence: number;
  readonly entry_hash: string;
  readonly head_generation: string;
}

export interface StoredEntry {
  readonly sequence: number;
  readonly previous_hash: string;
  readonly entry_hash: string;
  readonly entry: DeletionLedgerEntry;
}

export interface LedgerHead {
  readonly version: 1;
  readonly sequence: number;
  readonly entry_hash: string;
  readonly generation: string;
}

export interface DeletionLedgerSnapshot {
  readonly entries: readonly StoredEntry[];
  readonly head: DeletionLedgerReceipt;
}

export interface DeletionLedger {
  initialize(): Promise<void>;
  append(entry: DeletionLedgerEntry): Promise<DeletionLedgerReceipt>;
  readVerified(): Promise<readonly StoredEntry[]>;
  readSnapshot(): Promise<DeletionLedgerSnapshot>;
  currentHead(): Promise<DeletionLedgerReceipt>;
}

export const emptyDeletionLedgerHash = '0'.repeat(64);

const emptyHash = emptyDeletionLedgerHash;

/** A local, fsync-backed ledger port. Production deployments supply a separately governed object-store port. */
export class LocalDeletionLedger implements DeletionLedger {
  private readonly directory: string;

  constructor(directory: string) {
    if (directory.length === 0) throw new Error('DELETION_LEDGER_DIR must be set');
    this.directory = directory;
  }

  async initialize(): Promise<void> {
    await this.initializeDirectoryOnly();
    await this.readVerified();
  }

  static async createEmpty(directory: string): Promise<void> {
    if (directory.length === 0) throw new Error('DELETION_LEDGER_DIR must be set');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const ledger = new LocalDeletionLedger(directory);
    await ledger.withLock(async () => {
      const headPath = join(directory, 'HEAD.json');
      let missingHead = false;
      try {
        await readFile(headPath, 'utf8');
        await ledger.readHead();
      } catch (error) {
        if (!isNotFound(error))
          throw new Error('Unable to inspect the deletion ledger HEAD', { cause: error });
        missingHead = true;
      }
      if (missingHead) {
        const entries = (await readdir(directory)).filter((name) =>
          /^entry-[0-9]{12}\.json$/.test(name),
        );
        if (entries.length !== 0) throw new Error('Cannot initialize a ledger with orphan entries');
        const initial: LedgerHead = {
          version: 1,
          sequence: 0,
          entry_hash: emptyHash,
          generation: randomUUID(),
        };
        await writeDurable(headPath, canonicalDeletionLedgerJson(initial), 0o600);
        await syncDirectory(directory);
      }
    });
    await ledger.initialize();
  }

  async append(entry: DeletionLedgerEntry): Promise<DeletionLedgerReceipt> {
    validateDeletionLedgerEntry(entry);
    await this.initializeDirectoryOnly();
    return this.withLock(async () => {
      const head = await this.readHead();
      const files = await readdir(this.directory);
      const entries = files.filter((name) => /^entry-[0-9]{12}\.json$/.test(name)).sort();
      const committedEntries = entries.filter((name) => sequenceFromName(name) <= head.sequence);
      const verified = await this.verifyEntries(head, committedEntries);
      const existing = verified.find((stored) => stored.entry.request_id === entry.request_id);
      if (existing !== undefined) {
        if (canonicalDeletionLedgerJson(existing.entry) !== canonicalDeletionLedgerJson(entry)) {
          throw new Error('Deletion ledger request id has different contents');
        }
        return {
          sequence: existing.sequence,
          entry_hash: existing.entry_hash,
          head_generation: existing.entry_hash,
        };
      }

      const orphan = entries.find((name) => sequenceFromName(name) === head.sequence + 1);
      if (orphan !== undefined) {
        const stored = parseStoredDeletionLedgerEntry(
          await readFile(join(this.directory, orphan), 'utf8'),
        );
        if (
          canonicalDeletionLedgerJson(stored.entry) !== canonicalDeletionLedgerJson(entry) ||
          stored.sequence !== head.sequence + 1 ||
          stored.previous_hash !== head.entry_hash ||
          stored.entry_hash !== hashDeletionLedgerEntry(head.entry_hash, stored.entry)
        ) {
          throw new Error('Deletion ledger has an unacknowledged conflicting entry');
        }
        return this.advanceHead(stored);
      }
      if (entries.some((name) => sequenceFromName(name) > head.sequence + 1)) {
        throw new Error('Deletion ledger contains a sequence gap');
      }

      const stored: StoredEntry = {
        sequence: head.sequence + 1,
        previous_hash: head.entry_hash,
        entry_hash: hashDeletionLedgerEntry(head.entry_hash, entry),
        entry,
      };
      const entryPath = join(this.directory, entryName(stored.sequence));
      await writeDurable(entryPath, canonicalDeletionLedgerJson(stored), 0o600);
      await syncDirectory(this.directory);
      return this.advanceHead(stored);
    });
  }

  async readVerified(): Promise<readonly StoredEntry[]> {
    return (await this.readSnapshot()).entries;
  }

  async readSnapshot(): Promise<DeletionLedgerSnapshot> {
    await this.initializeDirectoryOnly();
    return this.withLock(async () => {
      const head = await this.readHead();
      const files = (await readdir(this.directory))
        .filter((name) => /^entry-[0-9]{12}\.json$/.test(name))
        .sort();
      const entries = await this.verifyEntries(head, files);
      return {
        entries,
        head: {
          sequence: head.sequence,
          entry_hash: head.entry_hash,
          head_generation: head.generation,
        },
      };
    });
  }

  async currentHead(): Promise<DeletionLedgerReceipt> {
    await this.initializeDirectoryOnly();
    return this.withLock(async () => {
      const head = await this.readHead();
      const files = (await readdir(this.directory))
        .filter((name) => /^entry-[0-9]{12}\.json$/.test(name))
        .sort();
      await this.verifyEntries(head, files);
      return {
        sequence: head.sequence,
        entry_hash: head.entry_hash,
        head_generation: head.generation,
      };
    });
  }

  private async initializeDirectoryOnly(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await stat(this.directory);
    if (!info.isDirectory()) throw new Error('Deletion ledger path must be a directory');
    let missingHead = false;
    try {
      await readFile(join(this.directory, 'HEAD.json'), 'utf8');
    } catch (error) {
      if (isNotFound(error)) missingHead = true;
      else throw new Error('Unable to read the deletion ledger HEAD', { cause: error });
    }
    if (missingHead) throw new Error('Deletion ledger HEAD is missing');
  }

  private async readHead(): Promise<LedgerHead> {
    const value: unknown = JSON.parse(await readFile(join(this.directory, 'HEAD.json'), 'utf8'));
    if (!isDeletionLedgerHead(value)) throw new Error('Deletion ledger HEAD is invalid');
    return value;
  }

  private async verifyEntries(head: LedgerHead, names: readonly string[]): Promise<StoredEntry[]> {
    if (head.sequence < 0 || !Number.isSafeInteger(head.sequence))
      throw new Error('Deletion ledger sequence is invalid');
    const bySequence = new Map(names.map((name) => [sequenceFromName(name), name]));
    if (names.length !== head.sequence) throw new Error('Deletion ledger is incomplete or stale');
    let previousHash = emptyHash;
    const verified: StoredEntry[] = [];
    for (let sequence = 1; sequence <= head.sequence; sequence += 1) {
      const name = bySequence.get(sequence);
      if (name === undefined) throw new Error('Deletion ledger contains a sequence gap');
      const stored = parseStoredDeletionLedgerEntry(
        await readFile(join(this.directory, name), 'utf8'),
      );
      if (
        stored.sequence !== sequence ||
        stored.previous_hash !== previousHash ||
        stored.entry_hash !== hashDeletionLedgerEntry(previousHash, stored.entry)
      ) {
        throw new Error('Deletion ledger hash chain is corrupt');
      }
      previousHash = stored.entry_hash;
      verified.push(stored);
    }
    if (head.entry_hash !== previousHash) throw new Error('Deletion ledger HEAD is stale');
    return verified;
  }

  private async advanceHead(stored: StoredEntry): Promise<DeletionLedgerReceipt> {
    const next: LedgerHead = {
      version: 1,
      sequence: stored.sequence,
      entry_hash: stored.entry_hash,
      generation: stored.entry_hash,
    };
    const tempPath = join(this.directory, `.HEAD-${randomUUID()}.tmp`);
    await writeDurable(tempPath, canonicalDeletionLedgerJson(next), 0o600);
    await rename(tempPath, join(this.directory, 'HEAD.json'));
    await syncDirectory(this.directory);
    return {
      sequence: next.sequence,
      entry_hash: next.entry_hash,
      head_generation: next.generation,
    };
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = join(this.directory, '.writer.lock');
    let lock;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        lock = await open(lockPath, 'wx', 0o600);
        await lock.writeFile(
          JSON.stringify({
            pid: process.pid,
            process_start: await processStartMarker(process.pid),
            acquired_at: Date.now(),
          }),
        );
        await lock.sync();
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (await removeDeadLock(lockPath)) continue;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (lock === undefined) throw new Error('Deletion ledger lock is busy');
    try {
      return await run();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
      await syncDirectory(this.directory);
    }
  }
}

export function validateDeletionLedgerEntry(entry: DeletionLedgerEntry): void {
  for (const value of [entry.request_id, entry.owner_id, entry.scope_id, entry.principal_id]) {
    if (!/^[0-9a-f-]{36}$/i.test(value))
      throw new Error('Deletion ledger identifiers must be UUIDs');
  }
  if (entry.actor_kind !== 'owner' || Number.isNaN(Date.parse(entry.blocked_at)))
    throw new Error('Deletion ledger entry actor or timestamp is invalid');
  for (const hash of entry.source_locator_hmacs) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Deletion ledger locator digest is invalid');
  }
  for (const id of [
    ...entry.target_memory_ids,
    ...entry.target_source_ids,
    ...entry.target_subject_ids,
  ]) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Deletion ledger target must be a UUID');
  }
}

export function parseStoredDeletionLedgerEntry(text: string): StoredEntry {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sequence' in value) ||
    !Number.isSafeInteger(value.sequence) ||
    !('previous_hash' in value) ||
    typeof value.previous_hash !== 'string' ||
    !('entry_hash' in value) ||
    typeof value.entry_hash !== 'string' ||
    !('entry' in value) ||
    typeof value.entry !== 'object' ||
    value.entry === null
  )
    throw new Error('Deletion ledger entry is invalid');
  const stored = value as StoredEntry;
  validateDeletionLedgerEntry(stored.entry);
  return stored;
}

export function isDeletionLedgerHead(value: unknown): value is LedgerHead {
  if (typeof value !== 'object' || value === null) return false;
  const head = value as Partial<LedgerHead>;
  return (
    head.version === 1 &&
    Number.isSafeInteger(head.sequence) &&
    typeof head.entry_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(head.entry_hash) &&
    typeof head.generation === 'string' &&
    head.generation.length >= 16
  );
}

function entryName(sequence: number): string {
  return `entry-${String(sequence).padStart(12, '0')}.json`;
}

function sequenceFromName(name: string): number {
  return Number(name.slice('entry-'.length, -'.json'.length));
}

export function hashDeletionLedgerEntry(previousHash: string, entry: DeletionLedgerEntry): string {
  return createHash('sha256')
    .update(`${previousHash}\n${canonicalDeletionLedgerJson(entry)}`)
    .digest('hex');
}

export function canonicalDeletionLedgerJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDeletionLedgerJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalDeletionLedgerJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function writeDurable(path: string, contents: string, mode: number): Promise<void> {
  const file = await open(path, 'wx', mode);
  try {
    await file.writeFile(contents, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function removeDeadLock(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > 5_000) {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        typeof value === 'object' &&
        value !== null &&
        'pid' in value &&
        'process_start' in value &&
        typeof value.pid === 'number' &&
        typeof value.process_start === 'string'
      ) {
        const currentStart = processExists(value.pid) ? await processStartMarker(value.pid) : null;
        if (currentStart !== value.process_start) {
          await rm(path, { force: true });
          return true;
        }
      }
    }
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
  return false;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function processStartMarker(pid: number): Promise<string | null> {
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = statLine.lastIndexOf(')');
    const fields = statLine
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    return startTime === undefined ? null : startTime;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
