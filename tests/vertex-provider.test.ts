import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredCuratorProviders,
  LocalDeterministicCuratorProvider,
  OpenAiCompatibleProvider,
  validateProposalEvidence,
  VertexAiProvider,
  type CuratorInput,
  type CuratorObservation,
} from '@memory/curator';
import { readCloudDeploymentConfig } from '../scripts/cloud-identity-config.mjs';

const cloudDeployment = await readCloudDeploymentConfig();
const source = 'I prefer a blue notebook for my morning work.';

describe('Vertex AI curator provider', () => {
  it('uses regional generateContent with the shared strict schema and refreshable ADC tokens', async () => {
    const observation = createObservation(source);
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const authClient = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce({ token: 'first-access-token' })
        .mockResolvedValueOnce({ token: 'refreshed-access-token' }),
    };
    const auth = { getClient: vi.fn(async () => authClient) };
    const provider = new VertexAiProvider({
      projectId: cloudDeployment.project,
      auth,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith(':predict')) {
          return jsonResponse({
            predictions: [{ embeddings: { values: Array.from({ length: 1536 }, () => 0.25) } }],
          });
        }
        return jsonResponse(generateResponse(observation));
      },
    });

    const result = await provider.extract(createInput(observation));
    const request = requests[0]!;
    const body = JSON.parse(String(request.init?.body)) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: {
        candidateCount: number;
        maxOutputTokens: number;
        responseMimeType: string;
        responseSchema: {
          additionalProperties: boolean;
          properties: {
            proposals: {
              items: {
                additionalProperties: boolean;
                properties: {
                  context: { additionalProperties: boolean };
                };
              };
            };
          };
        };
      };
    };

    expect(request.url).toBe(
      `https://${cloudDeployment.vertex.location}-aiplatform.googleapis.com/v1/projects/${cloudDeployment.project}/locations/${cloudDeployment.vertex.location}/publishers/google/models/${cloudDeployment.vertex.extractionModel}:generateContent`,
    );
    expect(new Headers(request.init?.headers).get('authorization')).toBe(
      'Bearer first-access-token',
    );
    expect(body.systemInstruction.parts[0]?.text).toContain('untrusted data');
    expect(body.systemInstruction.parts[0]?.text).toContain(
      'Each statement MUST be copied exactly, character for character',
    );
    expect(body.contents[0]).toMatchObject({ role: 'user' });
    expect(body.generationConfig).toMatchObject({
      candidateCount: 1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    });
    expect(body.generationConfig.responseSchema).toMatchObject({
      type: 'OBJECT',
      properties: {
        proposals: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { context: { type: 'OBJECT' } },
          },
        },
      },
    });
    expectVertexSchemaFields(body.generationConfig.responseSchema);
    expect(auth.getClient).toHaveBeenCalledTimes(1);
    expect(authClient.getAccessToken).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      usage: { inputTokens: 42, outputTokens: 19 },
      modelVersion: `${cloudDeployment.vertex.extractionModel}-001`,
      promptVersion: 'test-prompt-v1',
    });
    expect(validateProposalEvidence(result.proposals[0]!, [observation])).toMatchObject([
      { span: source },
    ]);

    await provider.embed([source]);
    expect(new Headers(requests[1]!.init?.headers).get('authorization')).toBe(
      'Bearer refreshed-access-token',
    );
    expect(authClient.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('retries ADC client discovery after a shared initialization failure', async () => {
    const observation = createObservation(source);
    const authClient = {
      getAccessToken: vi.fn(async () => ({ token: 'retry-access-token' })),
    };
    const auth = {
      getClient: vi
        .fn()
        .mockRejectedValueOnce(new Error('ADC discovery temporarily unavailable'))
        .mockResolvedValue(authClient),
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith(':predict')
        ? jsonResponse({
            predictions: [{ embeddings: { values: Array.from({ length: 1536 }, () => 0.5) } }],
          })
        : jsonResponse(generateResponse(observation)),
    );
    const provider = new VertexAiProvider({ projectId: cloudDeployment.project, auth, fetchImpl });

    const failedRequests = await Promise.allSettled([
      provider.extract(createInput(observation)),
      provider.embed([source]),
    ]);

    expect(failedRequests).toHaveLength(2);
    expect(failedRequests.every((result) => result.status === 'rejected')).toBe(true);
    expect(failedRequests[0]).toMatchObject({
      status: 'rejected',
      reason: new Error('ADC discovery temporarily unavailable'),
    });
    expect(auth.getClient).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    const [result, vectors] = await Promise.all([
      provider.extract(createInput(observation)),
      provider.embed([source]),
    ]);

    expect(auth.getClient).toHaveBeenCalledTimes(2);
    expect(authClient.getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.proposals).toHaveLength(1);
    expect(validateProposalEvidence(result.proposals[0]!, [observation])).toHaveLength(1);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1536);
  });

  it('sends one SEMANTIC_SIMILARITY prediction per input and preserves input order', async () => {
    const requests: { init: RequestInit | undefined }[] = [];
    let ordinal = 0;
    const provider = new VertexAiProvider({
      projectId: cloudDeployment.project,
      accessTokenProvider: async () => 'smoke-access-token',
      fetchImpl: async (_url, init) => {
        requests.push({ init });
        ordinal += 1;
        return jsonResponse({
          predictions: [
            { embeddings: { values: Array.from({ length: 1536 }, () => ordinal / 10) } },
          ],
        });
      },
    });

    const vectors = await provider.embed(['first text', 'second text']);

    expect(requests).toHaveLength(2);
    expect(
      requests.map(({ init }) => JSON.parse(String(init?.body)) as Record<string, unknown>),
    ).toEqual([
      {
        instances: [{ content: 'first text', task_type: 'SEMANTIC_SIMILARITY' }],
        parameters: { outputDimensionality: 1536 },
      },
      {
        instances: [{ content: 'second text', task_type: 'SEMANTIC_SIMILARITY' }],
        parameters: { outputDimensionality: 1536 },
      },
    ]);
    expect(vectors.map((vector) => vector[0])).toEqual([0.1, 0.2]);
    expect(vectors.every((vector) => vector.length === 1536)).toBe(true);
    expect(vectors.flat().every(Number.isFinite)).toBe(true);
  });

  it('rejects malformed, blocked, truncated, and schema-invalid extraction responses', async () => {
    const observation = createObservation(source);
    const malformed = createProvider({ fetchImpl: async () => new Response('{not-json') });
    await expect(malformed.extract(createInput(observation))).rejects.toThrow(/was not JSON/u);

    const blocked = createProvider({
      fetchImpl: async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    });
    await expect(blocked.extract(createInput(observation))).rejects.toThrow(/blocked/u);

    const truncated = createProvider({
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }],
        }),
    });
    await expect(truncated.extract(createInput(observation))).rejects.toThrow(/truncated/u);

    const invalidProposal = {
      proposals: [{ ...proposalFor(observation), unsupported: 'extra' }],
    };
    const invalidSchema = createProvider({
      fetchImpl: async () => jsonResponse(generationEnvelope(JSON.stringify(invalidProposal))),
    });
    await expect(invalidSchema.extract(createInput(observation))).rejects.toThrow(
      /proposal schema/u,
    );
  });

  it('fails closed on an invalid embedding dimension or a non-finite vector', async () => {
    const wrongDimension = createProvider({
      fetchImpl: async () =>
        jsonResponse({ predictions: [{ embeddings: { values: Array(1535).fill(0) } }] }),
    });
    await expect(wrongDimension.embed(['text'])).rejects.toThrow(/invalid embedding vector/u);

    const values = Array(1535).fill('0').concat('1e400').join(',');
    const nonFinite = createProvider({
      fetchImpl: async () =>
        new Response(`{"predictions":[{"embeddings":{"values":[${values}]}}]}`),
    });
    await expect(nonFinite.embed(['text'])).rejects.toThrow(/invalid embedding response/u);
  });

  it('aborts active requests on caller cancellation and its own deadline', async () => {
    const observation = createObservation(source);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waitingFetch: typeof fetch = async (_url, init) => {
      markStarted?.();
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const caller = new AbortController();
    const canceled = createProvider({ fetchImpl: waitingFetch });
    const pending = canceled.extract({ ...createInput(observation), signal: caller.signal });
    await started;
    caller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const timedOut = createProvider({ fetchImpl: waitingFetch, timeoutMs: 10 });
    await expect(timedOut.extract(createInput(observation))).rejects.toThrow(/timed out/u);
  });

  it('rejects oversized requests before contacting Vertex AI', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(generateResponse(createObservation(source))));
    const provider = createProvider({ fetchImpl });
    const oversized = createObservation('x'.repeat(1_000_000));

    await expect(provider.extract(createInput(oversized))).rejects.toThrow(/size limit/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('curator provider configuration', () => {
  it('defaults Vertex to the probed Singapore models and a fixed 1536 dimension', () => {
    const providers = createConfiguredCuratorProviders({
      CURATOR_PROVIDER: 'vertex',
      GOOGLE_CLOUD_PROJECT: cloudDeployment.project,
    });

    expect(providers).toMatchObject({
      extractionModelId: cloudDeployment.vertex.extractionModel,
      curator: { extractionModelId: cloudDeployment.vertex.extractionModel },
      embeddings: { modelId: cloudDeployment.vertex.embeddingModel, dimension: 1536 },
    });
    expect(providers.curator).toBeInstanceOf(VertexAiProvider);
  });

  it('requires explicit cloud configuration and refuses alternate or local fake Vertex models', () => {
    expect(() => createConfiguredCuratorProviders({ CURATOR_PROVIDER: 'vertex' })).toThrow(
      /PROJECT_ID/u,
    );
    expect(() =>
      createConfiguredCuratorProviders({
        CURATOR_PROVIDER: 'vertex',
        VERTEX_PROJECT_ID: cloudDeployment.project,
        EMBEDDING_DIMENSION: '768',
      }),
    ).toThrow(/fixed at 1536/u);
    expect(() =>
      createConfiguredCuratorProviders({
        CURATOR_PROVIDER: 'vertex',
        VERTEX_PROJECT_ID: cloudDeployment.project,
        CURATOR_MODEL_ID: 'local-fake-v1',
      }),
    ).toThrow(/local fake/u);
    expect(() =>
      createConfiguredCuratorProviders({
        CURATOR_PROVIDER: 'vertex',
        VERTEX_PROJECT_ID: cloudDeployment.project,
        VERTEX_LOCATION: 'global',
      }),
    ).toThrow(/regional location/u);
    expect(() => createConfiguredCuratorProviders({ CURATOR_PROVIDER: 'localfake' })).toThrow(
      /explicitly set/u,
    );
  });

  it('preserves explicit local and OpenAI-compatible configurations', () => {
    const local = createConfiguredCuratorProviders({ CURATOR_PROVIDER: 'local' });
    expect(local.curator).toBeInstanceOf(LocalDeterministicCuratorProvider);
    expect(local.extractionModelId).toBe('local-fake-v1');

    const openAi = createConfiguredCuratorProviders({
      CURATOR_PROVIDER: 'openai-compatible',
      CURATOR_BASE_URL: 'https://provider.example/v1',
      CURATOR_API_KEY: 'test-api-key',
      CURATOR_MODEL_ID: 'existing-chat-model',
      EMBEDDING_MODEL_ID: 'existing-embedding-model',
      EMBEDDING_DIMENSION: '1536',
    });
    expect(openAi.curator).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(openAi.extractionModelId).toBe('existing-chat-model');
    expect(openAi.embeddings.modelId).toBe('existing-embedding-model');
  });
});

function createProvider(options: {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs?: number;
}) {
  return new VertexAiProvider({
    projectId: cloudDeployment.project,
    accessTokenProvider: async () => 'test-access-token',
    ...options,
  });
}

function createInput(observation: CuratorObservation): CuratorInput {
  return {
    observations: [observation],
    candidates: [],
    promptVersion: 'test-prompt-v1',
    modelId: cloudDeployment.vertex.extractionModel,
    signal: new AbortController().signal,
    tokenBudget: 8_000,
  };
}

function expectVertexSchemaFields(value: unknown): void {
  const supported = new Set([
    'anyOf',
    'description',
    'enum',
    'items',
    'nullable',
    'properties',
    'required',
    'title',
    'type',
  ]);
  if (Array.isArray(value)) {
    for (const item of value) expectVertexSchemaFields(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    expect(supported.has(key), `unsupported Vertex schema field ${key}`).toBe(true);
    if (key === 'properties' && typeof nested === 'object' && nested !== null) {
      for (const propertySchema of Object.values(nested)) {
        expectVertexSchemaFields(propertySchema);
      }
      continue;
    }
    expectVertexSchemaFields(nested);
  }
}

function createObservation(content: string): CuratorObservation {
  return {
    id: randomUUID(),
    source_id: randomUUID(),
    source_kind: 'chat',
    source_revision: 'test-v1',
    locator: 'test/message/1',
    content,
    speaker: 'owner',
    event_time: null,
    lineage_root: randomUUID(),
  };
}

function proposalFor(observation: CuratorObservation) {
  return {
    kind: 'preference',
    statement: observation.content,
    context: {},
    subjects: [],
    valid_from: null,
    valid_to: null,
    epistemic_status: 'observed',
    contested: false,
    anchors: [
      {
        observation_id: observation.id,
        span_start: 0,
        span_end: observation.content.length,
      },
    ],
    rationale: '',
  };
}

function generateResponse(observation: CuratorObservation) {
  return generationEnvelope(JSON.stringify({ proposals: [proposalFor(observation)] }));
}

function generationEnvelope(content: string) {
  return {
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ text: content }] },
      },
    ],
    usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 19 },
    modelVersion: `${cloudDeployment.vertex.extractionModel}-001`,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
