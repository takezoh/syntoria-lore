import { describe, expect, it } from 'vitest';
import {
  DeterministicEmbeddingProvider,
  VertexEmbeddingProvider,
} from '../apps/api/src/embeddings.js';

function provider(fetch: typeof globalThis.fetch, dimension = 3) {
  return new VertexEmbeddingProvider({
    projectId: 'example-project',
    location: 'asia-southeast1',
    model: 'gemini-embedding-001',
    dimension,
    fetch,
    accessToken: async () => 'synthetic-access-token',
  });
}

describe('embedding providers', () => {
  it('calls the regional Vertex AI predict endpoint with the configured dimension', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const embeddings = provider(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ predictions: [{ embeddings: { values: [1, 0, 2] } }] }));
    });
    await expect(embeddings.embed('Lore keeps memories')).resolves.toEqual({
      modelId: 'vertex:gemini-embedding-001',
      dimension: 3,
      values: [1, 0, 2],
    });
    expect(calls[0]?.url).toBe(
      'https://asia-southeast1-aiplatform.googleapis.com/v1/projects/example-project/locations/asia-southeast1/publishers/google/models/gemini-embedding-001:predict',
    );
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      'Bearer synthetic-access-token',
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      instances: [{ content: 'Lore keeps memories', task_type: 'SEMANTIC_SIMILARITY' }],
      parameters: { outputDimensionality: 3 },
    });
  });

  it('rejects failed calls and vectors of the wrong shape', async () => {
    await expect(
      provider(async () => new Response('denied', { status: 403 })).embed('x'),
    ).rejects.toThrow('HTTP 403');
    for (const values of [[1, 2], [1, 2, Number.NaN], 'not-a-vector']) {
      await expect(
        provider(
          async () => new Response(JSON.stringify({ predictions: [{ embeddings: { values } }] })),
        ).embed('x'),
      ).rejects.toThrow('invalid embedding');
    }
  });

  it('gives the deterministic double a fixed dimension and stable output', async () => {
    const double = new DeterministicEmbeddingProvider(8);
    const first = await double.embed('Firestore memory records');
    expect(first.dimension).toBe(8);
    expect(first.values).toHaveLength(8);
    expect(await double.embed('Firestore memory records')).toEqual(first);
  });
});
