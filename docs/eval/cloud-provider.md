# Vertex AI provider verification — 2026-10-17

This dated record covers the Vertex AI extraction and embedding adapter. Provider configuration is in [infrastructure](../technical/infrastructure.md#model-providers); the smoke command is in the [infrastructure runbook](../technical/infrastructure-runbook.md#verification-harnesses).

## Contract under test

With `CURATOR_PROVIDER=vertex`, extraction uses `gemini-3.5-flash` through the regional `generateContent` endpoint in `asia-southeast1` with JSON response mode and a structural response schema derived from the strict curator proposal schema; every returned proposal is parsed with the full schema and each statement is validated as an exact anchor in the original observation. Embedding uses `gemini-embedding-001` with `SEMANTIC_SIMILARITY` and 1,536 dimensions, one input per prediction, batches of up to 128 sent sequentially in order. Credentials come from Application Default Credentials with a fresh token per request; there is no API key, global endpoint or fallback provider. Local contract regressions are in `tests/vertex-provider.test.ts` and `tests/curator.test.ts`.

## Executed evidence

- Live smoke against project `example-project` in `asia-southeast1` with a short-lived user-principal token passed with `gemini-3.5-flash` and `gemini-embedding-001`: one proposal passed exact-anchor validation and the embedding contained 1,536 finite values. The extractor reported 948 input and 219 output tokens. The run wrote nothing to the database or storage.
- The Vertex endpoint rejected JSON Schema validation metadata such as `pattern`, `format`, and numeric and length bounds. The wire schema therefore sends structural fields only and relies on the shared Zod schema for full post-generation validation.
- The deployed worker's service account later passed the ADC verification Job using the runtime image, returning one anchored proposal and a 1,536-dimensional embedding; see [cloud deployment evaluation](cloud-deploy.md).

## Limits

A passing smoke proves regional authentication, response-schema parsing, exact anchor validation and embedding shape for one synthetic request. It does not establish extraction quality, latency, quota, cost or service-level objectives.
