import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createConfiguredCuratorProviders, validateProposalEvidence } from '@memory/curator';

const source = '私は朝の作業で青いノートを使うのが好きです。';
const observation = {
  id: randomUUID(),
  source_id: randomUUID(),
  source_kind: 'chat',
  source_revision: 'cloud-provider-smoke-v1',
  locator: 'cloud-provider-smoke/synthetic',
  content: source,
  speaker: 'owner',
  event_time: null,
  lineage_root: randomUUID(),
};
let stage = 'configuration';

try {
  if (process.env['CURATOR_PROVIDER'] !== 'vertex') {
    throw new Error('CURATOR_PROVIDER must be explicitly set to vertex');
  }
  const tokenFile = process.env['CLOUD_PROVIDER_SMOKE_TOKEN_FILE'];
  const dependencies =
    tokenFile === undefined || tokenFile.length === 0
      ? {}
      : { vertexAccessToken: () => readPrivateAccessToken(tokenFile) };
  const providers = createConfiguredCuratorProviders(process.env, dependencies);
  if (providers.curator.modelId === 'local-fake-v1') {
    throw new Error('Cloud provider smoke cannot use the local fake provider');
  }

  stage = 'extract';
  const result = await providers.curator.extract({
    observations: [observation],
    candidates: [],
    promptVersion: providers.promptVersion,
    modelId: providers.extractionModelId,
    signal: AbortSignal.timeout(90_000),
    tokenBudget: 2048,
  });
  stage = 'anchor_validation';
  const anchored = result.proposals.map((proposal) =>
    validateProposalEvidence(proposal, [observation]),
  );
  if (result.proposals.length === 0 || anchored.some((anchors) => anchors.length === 0)) {
    throw new Error('Cloud provider smoke did not produce an anchored proposal');
  }

  stage = 'embedding';
  const [vector] = await providers.embeddings.embed([source], AbortSignal.timeout(90_000));
  if (
    vector === undefined ||
    vector.length !== 1536 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Cloud provider smoke returned an invalid embedding');
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      provider: 'vertex',
      location: process.env['VERTEX_LOCATION'] ?? 'asia-southeast1',
      extraction_model: providers.extractionModelId,
      embedding_model: providers.embeddings.modelId,
      embedding_dimension: vector.length,
      anchored_proposals: result.proposals.length,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: 'failed', stage, error: safeErrorCode(error) })}\n`,
  );
  process.exitCode = 1;
}

async function readPrivateAccessToken(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('CLOUD_PROVIDER_SMOKE_TOKEN_FILE must be a private regular file');
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32 || /\s/u.test(token)) {
    throw new Error('CLOUD_PROVIDER_SMOKE_TOKEN_FILE does not contain a valid access token');
  }
  return token;
}

function safeErrorCode(error) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code);
    if (/^[a-zA-Z0-9_.-]{1,64}$/u.test(code)) return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}
