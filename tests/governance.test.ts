import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_LOCAL_PORTABILITY_SIGNER_ID } from '@memory/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalDeletionLedger,
  LocalPortabilityStore,
  PortabilityCrypto,
  type DeletionLedgerEntry,
} from '../packages/governance/src/index.js';

const directories: string[] = [];

describe('portable v1 compatibility', () => {
  it('opens a bundle created by the previous runtime without changing its persisted identifiers', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/portable-v1-legacy.json', import.meta.url), 'utf8'),
    ) as {
      masterKey: string;
      signerId: string;
      payload: unknown;
      bundle: string;
    };
    expect(fixture.signerId).toBe(LEGACY_LOCAL_PORTABILITY_SIGNER_ID);
    const crypto = new PortabilityCrypto(fixture.masterKey, fixture.signerId);

    expect(crypto.open(fixture.bundle)).toEqual(fixture.payload);
  });
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local deletion ledger', () => {
  it('recovers a durable orphan written before a HEAD rename on an idempotent retry', async () => {
    const directory = await createLedgerDirectory();
    const ledger = new LocalDeletionLedger(directory);
    const first = ledgerEntry('00000000-0000-4000-8000-000000000001');
    const second = ledgerEntry('00000000-0000-4000-8000-000000000002');
    const firstReceipt = await ledger.append(first);

    const stored = {
      sequence: 2,
      previous_hash: firstReceipt.entry_hash,
      entry_hash: hash(firstReceipt.entry_hash, second),
      entry: { ...second, user_id: undefined, owner_id: second.user_id, actor_kind: 'owner' },
    };
    await writeFile(join(directory, 'entry-000000000002.json'), JSON.stringify(stored), {
      mode: 0o600,
      flag: 'wx',
    });
    await expect(ledger.readVerified()).rejects.toThrow(/incomplete or stale/);

    const recovered = await ledger.append(second);
    expect(recovered.sequence).toBe(2);
    expect(recovered.entry_hash).toBe(stored.entry_hash);
    expect(recovered.head_generation).toBe(stored.entry_hash);
    expect(await ledger.readVerified()).toHaveLength(2);
    expect(await ledger.append(second)).toEqual(recovered);
  });

  it('fails closed when the ledger is missing or its chain has been changed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-ledger-missing-'));
    directories.push(directory);
    await expect(new LocalDeletionLedger(directory).readVerified()).rejects.toThrow(
      /HEAD is missing/,
    );

    const readyDirectory = await createLedgerDirectory();
    const ledger = new LocalDeletionLedger(readyDirectory);
    await ledger.append(ledgerEntry('00000000-0000-4000-8000-000000000003'));
    const path = join(readyDirectory, 'entry-000000000001.json');
    const entry = JSON.parse(await readFile(path, 'utf8')) as {
      entry: DeletionLedgerEntry;
      [key: string]: unknown;
    };
    entry.entry = { ...entry.entry, reason_code: 'tampered' } as DeletionLedgerEntry;
    await writeFile(path, JSON.stringify(entry), { mode: 0o600 });
    await expect(ledger.readVerified()).rejects.toThrow(/hash chain is corrupt/);
  });
});

describe('local portability artifact storage', () => {
  it('cleans a crashed writer temp file without allowing one claim to delete another claim output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-portability-store-'));
    directories.push(directory);
    const store = new LocalPortabilityStore(
      directory,
      'local-test-portability-master-key-32-bytes-minimum',
      'unit-test-signer',
    );
    const exportId = '10000000-0000-4000-8000-000000000001';
    const claimA = '20000000-0000-4000-8000-000000000001';
    const claimB = '20000000-0000-4000-8000-000000000002';
    const artifactA = await store.write(exportId, 'claim-a', claimA);
    const artifactB = await store.write(exportId, 'claim-b', claimB);
    const crashedTemp = join(directory, `.${exportId}.${claimA}.${'a'.repeat(24)}.tmp`);
    await writeFile(crashedTemp, 'encrypted partial output', { mode: 0o600, flag: 'wx' });

    await store.remove(artifactA);
    await expect(access(join(directory, artifactA))).rejects.toThrow();
    await expect(access(crashedTemp)).rejects.toThrow();
    expect(await store.read(artifactB)).toBe('claim-b');

    await store.remove(`${exportId}.bundle`);
    const leftovers = (await readdir(directory)).filter((name) => name.startsWith(exportId));
    expect(leftovers).toEqual([]);
  });
});

async function createLedgerDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'memory-ledger-'));
  directories.push(directory);
  await LocalDeletionLedger.createEmpty(directory);
  return directory;
}

function ledgerEntry(requestId: string): DeletionLedgerEntry {
  return {
    request_id: requestId,
    user_id: '00000000-0000-4000-8000-000000000010',
    scope_id: '00000000-0000-4000-8000-000000000020',
    principal_id: '00000000-0000-4000-8000-000000000030',
    actor_kind: 'user',
    target_memory_ids: ['00000000-0000-4000-8000-000000000040'],
    target_source_ids: [],
    target_subject_ids: [],
    source_locator_hmacs: ['a'.repeat(64)],
    blocked_at: '2026-10-14T00:00:00.000Z',
  };
}

function hash(previousHash: string, entry: DeletionLedgerEntry): string {
  return createHash('sha256')
    .update(
      `${previousHash}\n${stableJson({ ...entry, user_id: undefined, owner_id: entry.user_id, actor_kind: 'owner' })}`,
    )
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    );
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
