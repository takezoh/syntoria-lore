import {
  type CloudObjectBucket,
  isCloudObjectNotFound,
  isCloudObjectPreconditionFailed,
  normalizeCloudObjectPrefix,
} from './cloud-object-bucket.js';
import { PortabilityCrypto, type PortabilityStore } from './portability-store.js';

const artifactLimitBytes = 16_000_000;
const defaultPrefix = 'artifacts/';
const cleanupPageSize = 100;

export interface CloudPortabilityStoreOptions {
  readonly prefix?: string;
  readonly cleanupPageSize?: number;
  readonly cleanupMaxPages?: number;
  readonly maxDeleteRetries?: number;
  readonly signerId: string;
}

export class CloudPortabilityStore extends PortabilityCrypto implements PortabilityStore {
  private readonly prefix: string;
  private readonly cleanupPageSize: number;
  private readonly cleanupMaxPages: number;
  private readonly maxDeleteRetries: number;

  constructor(
    private readonly bucket: CloudObjectBucket,
    masterKey: string,
    options: CloudPortabilityStoreOptions,
  ) {
    super(masterKey, options.signerId);
    this.prefix = normalizeCloudObjectPrefix(
      options.prefix ?? defaultPrefix,
      'GCS_ARTIFACT_PREFIX',
    );
    this.cleanupPageSize = options.cleanupPageSize ?? cleanupPageSize;
    this.cleanupMaxPages = options.cleanupMaxPages ?? 10;
    this.maxDeleteRetries = options.maxDeleteRetries ?? 4;
    if (
      !Number.isSafeInteger(this.cleanupPageSize) ||
      this.cleanupPageSize < 1 ||
      this.cleanupPageSize > 1000
    ) {
      throw new Error('Artifact cleanup page size must be between 1 and 1000');
    }
    if (
      !Number.isSafeInteger(this.cleanupMaxPages) ||
      this.cleanupMaxPages < 1 ||
      this.cleanupMaxPages > 100
    ) {
      throw new Error('Artifact cleanup pages must be between 1 and 100');
    }
    if (
      !Number.isSafeInteger(this.maxDeleteRetries) ||
      this.maxDeleteRetries < 1 ||
      this.maxDeleteRetries > 16
    ) {
      throw new Error('Artifact delete retries must be between 1 and 16');
    }
  }

  keyForClaim(exportId: string, claimToken: string): string {
    return `${normalizeExportId(exportId)}.${normalizeExportId(claimToken)}.bundle`;
  }

  async write(exportId: string, contents: string, claimToken: string): Promise<string> {
    const key = this.keyForClaim(exportId, claimToken);
    const body = Buffer.from(contents, 'utf8');
    if (body.length === 0 || body.length > artifactLimitBytes) {
      throw new Error('Portable artifact exceeds the storage size limit');
    }
    const name = this.objectName(key);
    try {
      await this.bucket.put(name, body, '0');
    } catch (error) {
      const existing = await this.bucket.get(name);
      if (existing !== null && existing.body.equals(body)) return key;
      if (isCloudObjectPreconditionFailed(error)) {
        throw new Error('Portable artifact claim already contains different contents', {
          cause: error,
        });
      }
      if (existing !== null) {
        throw new Error('Portable artifact claim already contains different contents', {
          cause: error,
        });
      }
      throw error;
    }
    return key;
  }

  async read(artifactKey: string): Promise<string> {
    const key = normalizeArtifactKey(artifactKey);
    const object = await this.bucket.get(this.objectName(key));
    if (object === null) throw new Error('Portable artifact is missing');
    if (object.body.length === 0 || object.body.length > artifactLimitBytes) {
      throw new Error('Portable artifact exceeds the storage size limit');
    }
    return object.body.toString('utf8');
  }

  async remove(artifactKey: string | null): Promise<void> {
    if (artifactKey === null) return;
    let key: string;
    try {
      key = normalizeArtifactKey(artifactKey);
    } catch {
      return;
    }
    const [exportId, claimToken] = key.slice(0, -'.bundle'.length).split('.');
    if (exportId === undefined) return;
    if (claimToken !== undefined) {
      await this.deleteCurrent(this.objectName(key));
      return;
    }
    await this.removeExportArtifacts(exportId);
  }

  private async removeExportArtifacts(exportId: string): Promise<void> {
    const prefix = this.objectName(`${exportId}.`);
    let pageToken: string | null = null;
    let pages = 0;
    do {
      const page = await this.bucket.list(prefix, pageToken, this.cleanupPageSize);
      for (const name of page.names) {
        if (!isArtifactForExport(name, this.prefix, exportId)) continue;
        await this.deleteCurrent(name);
      }
      pages += 1;
      pageToken = page.nextPageToken;
      if (pageToken !== null && pages >= this.cleanupMaxPages) {
        throw new Error('Portable artifact cleanup exceeded the per-pass page bound');
      }
    } while (pageToken !== null);
  }

  private async deleteCurrent(name: string): Promise<void> {
    for (let attempt = 0; attempt < this.maxDeleteRetries; attempt += 1) {
      const current = await this.bucket.get(name);
      if (current === null) return;
      try {
        await this.bucket.delete(name, current.generation);
        return;
      } catch (error) {
        if (isCloudObjectNotFound(error)) return;
        if (!isCloudObjectPreconditionFailed(error)) throw error;
      }
    }
    throw new Error('Portable artifact generation changed too often during deletion');
  }

  private objectName(key: string): string {
    return `${this.prefix}${key}`;
  }
}

function normalizeExportId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Export identifier is invalid');
  return value.toLowerCase();
}

function normalizeArtifactKey(value: string): string {
  const match = /^([0-9a-f-]{36})(?:\.([0-9a-f-]{36}))?\.bundle$/i.exec(value);
  if (match === null) throw new Error('Portable artifact key is invalid');
  const exportId = normalizeExportId(match[1] ?? '');
  const claimToken = match[2] === undefined ? undefined : normalizeExportId(match[2]);
  return claimToken === undefined ? `${exportId}.bundle` : `${exportId}.${claimToken}.bundle`;
}

function isArtifactForExport(name: string, prefix: string, exportId: string): boolean {
  const relative = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  return new RegExp(`^${exportId}(?:\\.[0-9a-f-]{36})?\\.bundle$`, 'i').test(relative);
}
