import { type Bucket, type FileMetadata, type Storage } from '@google-cloud/storage';

const maxPinnedGenerationReadAttempts = 3;

export interface CloudObject {
  readonly body: Buffer;
  readonly generation: string;
}

export interface CloudObjectPage {
  readonly names: readonly string[];
  readonly nextPageToken: string | null;
}

/** The small object API used by the durable governance adapters and fault tests. */
export interface CloudObjectBucket {
  get(name: string): Promise<CloudObject | null>;
  put(name: string, body: Buffer, ifGenerationMatch: string): Promise<void>;
  list(prefix: string, pageToken: string | null, pageSize: number): Promise<CloudObjectPage>;
  delete(name: string, generation: string): Promise<void>;
}

export class GoogleCloudObjectBucket implements CloudObjectBucket {
  constructor(private readonly bucket: Bucket) {}

  static forBucket(storage: Storage, bucketName: string): GoogleCloudObjectBucket {
    if (bucketName.length === 0) throw new Error('Cloud Storage bucket name is required');
    return new GoogleCloudObjectBucket(storage.bucket(bucketName));
  }

  async get(name: string): Promise<CloudObject | null> {
    for (let attempt = 0; attempt < maxPinnedGenerationReadAttempts; attempt += 1) {
      const generation = await this.currentGeneration(name);
      if (generation === null) return null;
      try {
        const [body] = await this.bucket
          .file(name, { generation })
          .download({ validation: 'crc32c' });
        return { body, generation };
      } catch (error) {
        if (!isCloudObjectNotFound(error)) throw error;
        if (attempt + 1 < maxPinnedGenerationReadAttempts) continue;

        // A final observation distinguishes a retired generation from a missing current object.
        if ((await this.currentGeneration(name)) === null) return null;
        throw new Error('Cloud Storage object changed during bounded generation read', {
          cause: error,
        });
      }
    }
    throw new Error('Cloud Storage object read exceeded its generation retry bound');
  }

  async put(name: string, body: Buffer, ifGenerationMatch: string): Promise<void> {
    if (!/^(0|[1-9][0-9]*)$/.test(ifGenerationMatch)) {
      throw new Error('Cloud Storage generation precondition is invalid');
    }
    await this.bucket.file(name).save(body, {
      resumable: false,
      validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch },
      metadata: { cacheControl: 'no-store' },
    });
  }

  async list(prefix: string, pageToken: string | null, pageSize: number): Promise<CloudObjectPage> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new Error('Cloud Storage page size must be between 1 and 1000');
    }
    const [files, nextQuery] = await this.bucket.getFiles({
      prefix,
      maxResults: pageSize,
      autoPaginate: false,
      ...(pageToken === null ? {} : { pageToken }),
    });
    return {
      names: files.map((file) => file.name),
      nextPageToken:
        typeof nextQuery?.pageToken === 'string' && nextQuery.pageToken.length > 0
          ? nextQuery.pageToken
          : null,
    };
  }

  async delete(name: string, generation: string): Promise<void> {
    if (!/^[1-9][0-9]*$/.test(generation)) {
      throw new Error('Cloud Storage object generation is invalid');
    }
    await this.bucket
      .file(name, { preconditionOpts: { ifGenerationMatch: generation } })
      .delete({ ignoreNotFound: true });
  }

  private async currentGeneration(name: string): Promise<string | null> {
    let metadata: FileMetadata;
    try {
      [metadata] = await this.bucket.file(name).getMetadata();
    } catch (error) {
      if (isCloudObjectNotFound(error)) return null;
      throw error;
    }
    const generation = metadata.generation;
    if (typeof generation !== 'string' || !/^[1-9][0-9]*$/.test(generation)) {
      throw new Error('Cloud Storage returned an invalid object generation');
    }
    return generation;
  }
}

export function normalizeCloudObjectPrefix(value: string, variable: string): string {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\') || value.length > 512) {
    throw new Error(`${variable} must be a relative Cloud Storage prefix`);
  }
  const segments = value.replace(/\/+$/, '').split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error(`${variable} contains an invalid Cloud Storage path segment`);
  }
  return `${segments.join('/')}/`;
}

export function isCloudObjectNotFound(error: unknown): boolean {
  return cloudErrorCode(error) === 404;
}

export function isCloudObjectPreconditionFailed(error: unknown): boolean {
  return cloudErrorCode(error) === 412;
}

function cloudErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const value = (error as { code?: unknown }).code;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]{3}$/.test(value)) return Number(value);
  return null;
}
