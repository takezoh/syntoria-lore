import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import type { Embedding, EmbeddingProvider } from '@memory/memory-records';
import type { EmbeddingConfig } from './config.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_INPUT_CHARACTERS = 20_000;

export interface VertexEmbeddingOptions {
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly dimension: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides Application Default Credentials, for tests. */
  readonly accessToken?: () => Promise<string>;
}

/**
 * Vertex AI text embeddings through the regional `:predict` endpoint, authenticated with
 * Application Default Credentials. One text per call.
 */
export class VertexEmbeddingProvider implements EmbeddingProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly accessToken: () => Promise<string>;

  constructor(private readonly options: VertexEmbeddingOptions) {
    this.endpoint = `https://${options.location}-aiplatform.googleapis.com/v1/projects/${options.projectId}/locations/${options.location}/publishers/google/models/${options.model}:predict`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (options.accessToken !== undefined) {
      this.accessToken = options.accessToken;
    } else {
      const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
      this.accessToken = async () => {
        const token = await auth.getAccessToken();
        if (typeof token !== 'string' || token.length === 0 || /\s/u.test(token)) {
          throw new Error('Application Default Credentials did not provide an access token');
        }
        return token;
      };
    }
  }

  async embed(text: string): Promise<Embedding> {
    const body = JSON.stringify({
      instances: [
        { content: text.slice(0, MAX_INPUT_CHARACTERS), task_type: 'SEMANTIC_SIMILARITY' },
      ],
      parameters: { outputDimensionality: this.options.dimension },
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new Error('Embedding request exceeds the size limit');
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
      },
      body,
      signal,
      redirect: 'error',
    });
    const payload = await readBoundedJson(response);
    const predictions =
      typeof payload === 'object' && payload !== null
        ? (payload as { predictions?: unknown }).predictions
        : undefined;
    const values =
      Array.isArray(predictions) && predictions.length === 1
        ? (predictions[0] as { embeddings?: { values?: unknown } } | undefined)?.embeddings?.values
        : undefined;
    if (
      !Array.isArray(values) ||
      values.length !== this.options.dimension ||
      values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new Error('Vertex AI returned an invalid embedding');
    }
    return {
      modelId: `vertex:${this.options.model}`,
      dimension: this.options.dimension,
      values: values as number[],
    };
  }
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Vertex AI request failed with HTTP ${response.status}`);
  }
  if (response.body === null) throw new Error('Vertex AI response had no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Vertex AI response exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/**
 * A local embedding double: hashed term counts in a fixed number of buckets. It makes the
 * index and recall paths testable; it says nothing about semantic recall quality.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dimension = 64) {}

  async embed(text: string): Promise<Embedding> {
    const values = Array.from({ length: this.dimension }, () => 0);
    for (const word of text
      .normalize('NFKC')
      .toLocaleLowerCase('und')
      .match(/[\p{L}\p{N}]+/gu) ?? []) {
      const bucket = createHash('sha256').update(word).digest().readUInt32BE(0) % this.dimension;
      values[bucket] = values[bucket]! + 1;
    }
    return { modelId: 'deterministic-test', dimension: this.dimension, values };
  }
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  return config.provider === 'deterministic'
    ? new DeterministicEmbeddingProvider()
    : new VertexEmbeddingProvider(config);
}
