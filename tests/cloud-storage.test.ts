import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudDeletionLedger,
  CloudPortabilityStore,
  GoogleCloudObjectBucket,
  canonicalDeletionLedgerJson,
  emptyDeletionLedgerHash,
  hashDeletionLedgerEntry,
  type CloudObjectBucket,
  type DeletionLedgerEntry,
} from '../packages/governance/src/index.js';
import {
  createDeletionLedger,
  createGovernanceStorage,
} from '../packages/runtime/src/governance-storage.js';

describe('cloud deletion ledger', () => {
  it('serializes concurrent writers through generation CAS and returns the same receipt after a lost response', async () => {
    const bucket = new MemoryCloudObjectBucket();
    const first = new CloudDeletionLedger(bucket, { prefix: 'ledger/race/' });
    const second = new CloudDeletionLedger(bucket, { prefix: 'ledger/race/' });
    await first.bootstrapEmpty(false);

    const one = ledgerEntry(randomUUID());
    const two = ledgerEntry(randomUUID());
    const [oneReceipt, twoReceipt] = await Promise.all([first.append(one), second.append(two)]);
    expect([oneReceipt.sequence, twoReceipt.sequence].sort()).toEqual([1, 2]);
    const snapshot = await first.readSnapshot();
    expect(snapshot.entries.map((stored) => stored.entry.request_id).sort()).toEqual(
      [one.request_id, two.request_id].sort(),
    );

    bucket.throwAfterSuccessfulPut = 'ledger/race/HEAD.json';
    const three = ledgerEntry(randomUUID());
    const resolved = await first.append(three);
    expect(resolved.sequence).toBe(3);
    expect(await first.append(three)).toEqual(resolved);
  });

  it('ignores orphan nodes, rejects conflicting request ids, and never recreates a missing HEAD', async () => {
    const bucket = new MemoryCloudObjectBucket();
    const ledger = new CloudDeletionLedger(bucket, { prefix: 'ledger/fail-closed/' });
    const initial = await ledger.bootstrapEmpty(false);
    const orphan = ledgerEntry(randomUUID());
    const orphanHash = hashDeletionLedgerEntry(emptyDeletionLedgerHash, orphan);
    await bucket.put(
      `ledger/fail-closed/objects/${orphanHash}.json`,
      Buffer.from(
        canonicalDeletionLedgerJson({
          sequence: 1,
          previous_hash: emptyDeletionLedgerHash,
          entry_hash: orphanHash,
          entry: orphan,
        }),
      ),
      '0',
    );
    expect((await ledger.readSnapshot()).head).toEqual(initial);

    const committed = await ledger.append(orphan);
    await expect(
      ledger.append({ ...orphan, blocked_at: '2026-10-18T00:00:00.000Z' }),
    ).rejects.toThrow(/different contents/);
    expect(committed.sequence).toBe(1);

    const headObject = await bucket.get('ledger/fail-closed/HEAD.json');
    expect(headObject).not.toBeNull();
    const malformedHead = JSON.parse(headObject!.body.toString('utf8')) as Record<string, unknown>;
    malformedHead['generation'] = randomUUID();
    await bucket.put(
      'ledger/fail-closed/HEAD.json',
      Buffer.from(JSON.stringify(malformedHead)),
      headObject!.generation,
    );
    await expect(ledger.readSnapshot()).rejects.toThrow(/HEAD is invalid/);

    bucket.removeForFault(`ledger/fail-closed/HEAD.json`);
    await expect(ledger.initialize()).rejects.toThrow(/HEAD is missing/);
    await expect(ledger.append(ledgerEntry(randomUUID()))).rejects.toThrow(/HEAD is missing/);
    expect(await bucket.get('ledger/fail-closed/HEAD.json')).toBeNull();
  });

  it('allows bootstrap only for a new empty namespace and records its sentinel first', async () => {
    const bucket = new MemoryCloudObjectBucket();
    const ledger = new CloudDeletionLedger(bucket, { prefix: 'ledger/bootstrap/' });
    await expect(ledger.bootstrapEmpty(true)).rejects.toThrow(/database with history/);
    const receipt = await ledger.bootstrapEmpty(false);
    expect(receipt).toMatchObject({ sequence: 0, entry_hash: emptyDeletionLedgerHash });
    expect(await bucket.get('ledger/bootstrap/BOOTSTRAP.json')).not.toBeNull();

    const interruptedBucket = new MemoryCloudObjectBucket();
    await interruptedBucket.put('ledger/interrupted/BOOTSTRAP.json', Buffer.from('{}'), '0');
    const interrupted = new CloudDeletionLedger(interruptedBucket, {
      prefix: 'ledger/interrupted/',
    });
    await expect(interrupted.bootstrapEmpty(false)).rejects.toThrow(/not new and empty/);

    const orphanBucket = new MemoryCloudObjectBucket();
    await orphanBucket.put('ledger/orphan/objects/a.json', Buffer.from('{}'), '0');
    const orphanLedger = new CloudDeletionLedger(orphanBucket, { prefix: 'ledger/orphan/' });
    await expect(orphanLedger.bootstrapEmpty(false)).rejects.toThrow(/not new and empty/);
  });
});

describe('cloud portability artifact storage', () => {
  it('round-trips canonicalized objects without depending on property insertion order', () => {
    const store = new CloudPortabilityStore(
      new MemoryCloudObjectBucket(),
      'unit test portability master key: 32+ bytes',
      { prefix: 'artifacts/property-order/', signerId: 'unit-test-signer' },
    );
    const payload = { smoke_id: 'smoke', claim: 'claim', ordinal: 0 };
    const encrypted = store.seal(payload);
    const opened = store.open(encrypted);

    expect(JSON.stringify(opened)).not.toBe(JSON.stringify(payload));
    expect(opened).toEqual(payload);
  });

  it('uses create-only claims, fences deletion by generation, and keeps cleanup pending across pages', async () => {
    const bucket = new MemoryCloudObjectBucket();
    const store = new CloudPortabilityStore(bucket, 'unit test portability master key: 32+ bytes', {
      prefix: 'artifacts/unit/',
      signerId: 'unit-test-signer',
      cleanupPageSize: 2,
      cleanupMaxPages: 1,
    });
    const exportId = randomUUID();
    const claims = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const keys = await Promise.all(
      claims.map(async (claim, index) => {
        const encrypted = store.seal({ claim, payload: `payload-${index}` });
        const key = await store.write(exportId, encrypted, claim);
        expect(store.open(await store.read(key))).toEqual({ claim, payload: `payload-${index}` });
        return { claim, encrypted, key };
      }),
    );

    await expect(store.write(exportId, keys[0]!.encrypted, keys[0]!.claim)).resolves.toBe(
      keys[0]!.key,
    );
    await expect(
      store.write(exportId, 'different encrypted contents', keys[0]!.claim),
    ).rejects.toThrow(/different contents/);

    const firstObject = `artifacts/unit/${keys[0]!.key}`;
    bucket.replaceBeforeNextDelete = firstObject;
    await store.remove(keys[0]!.key);
    await expect(store.read(keys[0]!.key)).rejects.toThrow(/missing/);
    await expect(store.read(keys[1]!.key)).resolves.toBe(keys[1]!.encrypted);
    await expect(store.remove(null)).resolves.toBeUndefined();

    await expect(store.remove(`${exportId}.bundle`)).rejects.toThrow(/page bound/);
    await expect(store.remove(`${exportId}.bundle`)).rejects.toThrow(/page bound/);
    await expect(store.remove(`${exportId}.bundle`)).resolves.toBeUndefined();
    for (const { key } of keys) await expect(store.read(key)).rejects.toThrow(/missing/);
  });
});

describe('Google Cloud Storage object adapter', () => {
  it('re-observes metadata after a pinned generation disappears and returns only the refreshed generation body', async () => {
    const metadataFile = {
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce([{ generation: '41' }])
        .mockResolvedValueOnce([{ generation: '42' }]),
    };
    const retiredGenerationFile = {
      download: vi.fn(async () => {
        throw cloudError(404);
      }),
    };
    const currentGenerationFile = {
      download: vi.fn(async () => [Buffer.from('head generation 42')]),
    };
    const bucket = {
      file: vi.fn((_name: string, options?: Record<string, unknown>) => {
        if (options?.['generation'] === '41') return retiredGenerationFile;
        if (options?.['generation'] === '42') return currentGenerationFile;
        return metadataFile;
      }),
    };
    const adapter = new GoogleCloudObjectBucket(bucket as never);

    await expect(adapter.get('HEAD.json')).resolves.toEqual({
      body: Buffer.from('head generation 42'),
      generation: '42',
    });
    expect(metadataFile.getMetadata).toHaveBeenCalledTimes(2);
    expect(bucket.file).toHaveBeenNthCalledWith(2, 'HEAD.json', { generation: '41' });
    expect(bucket.file).toHaveBeenNthCalledWith(4, 'HEAD.json', { generation: '42' });
    expect(retiredGenerationFile.download).toHaveBeenCalledWith({ validation: 'crc32c' });
    expect(currentGenerationFile.download).toHaveBeenCalledWith({ validation: 'crc32c' });
  });

  it('keeps missing HEAD fail-closed when its pinned generation vanishes before download', async () => {
    const metadataFile = {
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce([{ generation: '41' }])
        .mockRejectedValueOnce(cloudError(404)),
    };
    const retiredGenerationFile = {
      download: vi.fn(async () => {
        throw cloudError(404);
      }),
    };
    const bucket = {
      file: vi.fn((_name: string, options?: Record<string, unknown>) =>
        options?.['generation'] === '41' ? retiredGenerationFile : metadataFile,
      ),
    };
    const ledger = new CloudDeletionLedger(new GoogleCloudObjectBucket(bucket as never), {
      prefix: 'ledger/missing-race/',
    });

    await expect(ledger.currentHead()).rejects.toThrow(/HEAD is missing/);
    expect(metadataFile.getMetadata).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated generation changes after a final metadata re-observation', async () => {
    const metadataFile = {
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce([{ generation: '41' }])
        .mockResolvedValueOnce([{ generation: '42' }])
        .mockResolvedValueOnce([{ generation: '43' }])
        .mockResolvedValueOnce([{ generation: '44' }]),
    };
    const changingGenerationFile = {
      download: vi.fn(async () => {
        throw cloudError(404);
      }),
    };
    const bucket = {
      file: vi.fn((_name: string, options?: Record<string, unknown>) =>
        options?.['generation'] === undefined ? metadataFile : changingGenerationFile,
      ),
    };
    const adapter = new GoogleCloudObjectBucket(bucket as never);

    await expect(adapter.get('HEAD.json')).rejects.toThrow(/bounded generation read/);
    expect(metadataFile.getMetadata).toHaveBeenCalledTimes(4);
    expect(changingGenerationFile.download).toHaveBeenCalledTimes(3);
  });

  it('uses generation preconditions and treats the SDK null query on the final list page as terminal', async () => {
    const metadataFile = {
      getMetadata: vi.fn(async () => [{ generation: '41' }]),
      download: vi.fn(async () => [Buffer.from('body')]),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const generationFile = {
      download: vi.fn(async () => [Buffer.from('body')]),
    };
    const listedFile = { name: 'objects/item.json' };
    const getFiles = vi
      .fn()
      .mockResolvedValueOnce([[listedFile], { pageToken: 'next' }, {}])
      .mockResolvedValueOnce([[], null, {}]);
    const bucket = {
      file: vi.fn((_name: string, options?: Record<string, unknown>) =>
        options?.['generation'] === '41' ? generationFile : metadataFile,
      ),
      getFiles,
    };
    const adapter = new GoogleCloudObjectBucket(bucket as never);

    await expect(adapter.get('objects/item.json')).resolves.toEqual({
      body: Buffer.from('body'),
      generation: '41',
    });
    await adapter.put('objects/item.json', Buffer.from('node'), '0');
    await adapter.put('HEAD.json', Buffer.from('head'), '41');
    await expect(adapter.list('objects/', null, 10)).resolves.toEqual({
      names: ['objects/item.json'],
      nextPageToken: 'next',
    });
    await expect(adapter.list('objects/', 'next', 10)).resolves.toEqual({
      names: [],
      nextPageToken: null,
    });
    await adapter.delete('objects/item.json', '41');

    expect(metadataFile.save).toHaveBeenNthCalledWith(
      1,
      Buffer.from('node'),
      expect.objectContaining({ preconditionOpts: { ifGenerationMatch: '0' }, resumable: false }),
    );
    expect(metadataFile.save).toHaveBeenNthCalledWith(
      2,
      Buffer.from('head'),
      expect.objectContaining({ preconditionOpts: { ifGenerationMatch: '41' }, resumable: false }),
    );
    expect(getFiles).toHaveBeenNthCalledWith(1, {
      prefix: 'objects/',
      maxResults: 10,
      autoPaginate: false,
    });
    expect(getFiles).toHaveBeenNthCalledWith(2, {
      prefix: 'objects/',
      maxResults: 10,
      autoPaginate: false,
      pageToken: 'next',
    });
    expect(bucket.file).toHaveBeenCalledWith('objects/item.json', {
      preconditionOpts: { ifGenerationMatch: '41' },
    });
    expect(metadataFile.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
});

describe('governance storage selection', () => {
  it('builds a ledger-only local or cloud port without requiring artifact settings', () => {
    const local = createDeletionLedger({ DELETION_LEDGER_DIR: '/tmp/local-ledger-only' });
    expect(local.constructor.name).toBe('LocalDeletionLedger');

    const bucket = new MemoryCloudObjectBucket();
    const cloud = createDeletionLedger(
      {
        STORAGE_MODE: 'gcs',
        GCS_LEDGER_BUCKET: 'ledger-test',
        GCS_LEDGER_PREFIX: 'verification/restore/',
      },
      { createObjectBucket: () => bucket },
    );
    expect(cloud.constructor.name).toBe('CloudDeletionLedger');
  });

  it('keeps local as the default and fails closed for partial cloud configuration', () => {
    const local = createGovernanceStorage({
      DELETION_LEDGER_DIR: '/tmp/local-ledger',
      PORTABILITY_STORAGE_DIR: '/tmp/local-artifacts',
      PORTABILITY_MASTER_KEY: 'unit test portability master key: 32+ bytes',
      PORTABILITY_SIGNER_ID: 'unit-test-signer',
    });
    expect(local.deletionLedger.constructor.name).toBe('LocalDeletionLedger');
    expect(local.portabilityStore.constructor.name).toBe('LocalPortabilityStore');

    expect(() =>
      createGovernanceStorage({
        STORAGE_MODE: 'gcs',
        GCS_LEDGER_BUCKET: 'ledger-bucket',
        PORTABILITY_MASTER_KEY: 'unit test portability master key: 32+ bytes',
        PORTABILITY_SIGNER_ID: 'unit-test-signer',
      }),
    ).toThrow(/GCS_ARTIFACT_BUCKET is required/);
    expect(() =>
      createGovernanceStorage({
        STORAGE_MODE: 'local',
        GCS_LEDGER_BUCKET: 'ledger-bucket',
      }),
    ).toThrow(/cannot be used with/);
  });

  it('selects both cloud adapters through one factory and honors isolated prefixes', async () => {
    const ledgerBucket = new MemoryCloudObjectBucket();
    const artifactBucket = new MemoryCloudObjectBucket();
    const requestedBuckets: string[] = [];
    const storage = createGovernanceStorage(
      {
        STORAGE_MODE: 'gcs',
        GCS_LEDGER_BUCKET: 'ledger-test',
        GCS_ARTIFACT_BUCKET: 'artifact-test',
        GCS_LEDGER_PREFIX: 'verification/ledger/',
        GCS_ARTIFACT_PREFIX: 'verification/artifacts/',
        PORTABILITY_MASTER_KEY: 'unit test portability master key: 32+ bytes',
        PORTABILITY_SIGNER_ID: 'unit-test-signer',
      },
      {
        createObjectBucket: (bucketName) => {
          requestedBuckets.push(bucketName);
          if (bucketName === 'ledger-test') return ledgerBucket;
          if (bucketName === 'artifact-test') return artifactBucket;
          throw new Error('unexpected bucket');
        },
      },
    );

    expect(storage.deletionLedger.constructor.name).toBe('CloudDeletionLedger');
    expect(storage.portabilityStore.constructor.name).toBe('CloudPortabilityStore');
    expect(requestedBuckets).toEqual(['ledger-test', 'artifact-test']);
    await (storage.deletionLedger as CloudDeletionLedger).bootstrapEmpty(false);
    expect(await ledgerBucket.get('verification/ledger/HEAD.json')).not.toBeNull();
    const exportId = randomUUID();
    const claim = randomUUID();
    const key = await storage.portabilityStore.write(exportId, 'sealed payload', claim);
    expect(await artifactBucket.get(`verification/artifacts/${key}`)).not.toBeNull();
  });
});

class MemoryCloudObjectBucket implements CloudObjectBucket {
  private readonly objects = new Map<string, { body: Buffer; generation: string }>();
  private generation = 0;
  throwAfterSuccessfulPut: string | null = null;
  replaceBeforeNextDelete: string | null = null;

  async get(name: string): Promise<{ body: Buffer; generation: string } | null> {
    const object = this.objects.get(name);
    return object === undefined
      ? null
      : { body: Buffer.from(object.body), generation: object.generation };
  }

  async put(name: string, body: Buffer, ifGenerationMatch: string): Promise<void> {
    const current = this.objects.get(name);
    if (
      (ifGenerationMatch === '0' && current !== undefined) ||
      (ifGenerationMatch !== '0' && current?.generation !== ifGenerationMatch)
    ) {
      throw cloudError(412);
    }
    this.objects.set(name, { body: Buffer.from(body), generation: String(++this.generation) });
    if (this.throwAfterSuccessfulPut === name) {
      this.throwAfterSuccessfulPut = null;
      throw cloudError('ECONNRESET');
    }
  }

  async list(prefix: string, pageToken: string | null, pageSize: number) {
    const names = [...this.objects.keys()].filter((name) => name.startsWith(prefix)).sort();
    const after = pageToken === null ? names : names.filter((name) => name > pageToken);
    const pageNames = after.slice(0, pageSize);
    const hasMore = after.length > pageNames.length;
    return {
      names: pageNames,
      nextPageToken: hasMore ? (pageNames.at(-1) ?? null) : null,
    };
  }

  async delete(name: string, generation: string): Promise<void> {
    const current = this.objects.get(name);
    if (current === undefined) throw cloudError(404);
    if (this.replaceBeforeNextDelete === name) {
      this.replaceBeforeNextDelete = null;
      this.objects.set(name, {
        body: Buffer.from('raced replacement'),
        generation: String(++this.generation),
      });
    }
    if (this.objects.get(name)?.generation !== generation) throw cloudError(412);
    this.objects.delete(name);
  }

  removeForFault(name: string): void {
    this.objects.delete(name);
  }
}

function ledgerEntry(requestId: string): DeletionLedgerEntry {
  return {
    request_id: requestId,
    owner_id: randomUUID(),
    scope_id: randomUUID(),
    principal_id: randomUUID(),
    actor_kind: 'owner',
    target_memory_ids: [],
    target_source_ids: [],
    target_subject_ids: [],
    source_locator_hmacs: [],
    blocked_at: '2026-10-17T00:00:00.000Z',
  };
}

function cloudError(code: number | string): Error & { code: number | string } {
  return Object.assign(new Error(`Cloud object error ${code}`), { code });
}
