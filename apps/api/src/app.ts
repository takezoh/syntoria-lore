import type { JWTVerifyGetKey } from 'jose';
import type { RequestListener } from 'node:http';
import {
  createMemoryRecordsRuntime,
  ObservationService,
  type EmbeddingProvider,
  type RecallAssessor,
  type MemoryRecordsRuntime,
} from '@memory/memory-records';
import type { ApiConfig } from './config.js';
import { createEmbeddingProvider } from './embeddings.js';
import { VertexRecallAssessor } from './recall-assessment.js';
import { createAccessVerifier } from './access.js';
import { createGateVerifier } from './gate.js';
import { createRequestListener } from './server.js';

export interface ApiApp {
  readonly listener: RequestListener;
  readonly runtime: MemoryRecordsRuntime;
  close(): Promise<void>;
}

export interface ApiAppOverrides {
  readonly embeddings?: EmbeddingProvider;
  readonly recallAssessor?: RecallAssessor;
  readonly accessKeys?: JWTVerifyGetKey;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

/** Wires the Firestore runtime, the memory service, Gate verification and the HTTP listener. */
export function createApiApp(config: ApiConfig, overrides: ApiAppOverrides = {}): ApiApp {
  const log = overrides.log ?? ((event) => console.log(JSON.stringify(event)));
  const runtime = createMemoryRecordsRuntime({
    projectId: config.firestoreProjectId,
    databaseId: config.firestoreDatabaseId,
    ledgerDatabaseId: config.ledgerDatabaseId,
    cursorSecret: config.cursorSecret,
  });
  const recallAssessor =
    overrides.recallAssessor ??
    (config.recallAssessment === undefined
      ? undefined
      : new VertexRecallAssessor(config.recallAssessment));
  const service = new ObservationService({
    ledger: runtime.observations,
    access: runtime.access,
    embeddings: overrides.embeddings ?? createEmbeddingProvider(config.embedding),
    ...(recallAssessor === undefined ? {} : { recallAssessor }),
    log,
  });
  service.startMaintenance();
  const accessVerifier =
    config.access === undefined
      ? undefined
      : createAccessVerifier(config.access, overrides.accessKeys);
  const verifier =
    config.access !== undefined
      ? {
          verifyToken: async () => {
            throw new Error('Legacy credentials disabled');
          },
          authenticate: async () => {
            throw new Error('Legacy credentials disabled');
          },
        }
      : createGateVerifier(
          {
            issuer: config.gateIssuer,
            audience: config.mcpResourceUrl,
            clientId: config.gateClientId,
            clientSecret: config.gateClientSecret,
            ...(config.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
          },
          overrides.fetch === undefined ? {} : { fetch: overrides.fetch },
        );
  const listener = createRequestListener({
    mcpResourceUrl: config.mcpResourceUrl,
    gateIssuer: config.gateIssuer,
    mcpAllowedHosts: config.mcpAllowedHosts,
    verifier,
    ...(config.access === undefined || accessVerifier === undefined
      ? {}
      : {
          authenticateAssertion: async (assertion: string | undefined) => {
            await accessVerifier.authenticate(assertion);
            // The mapping selects an existing owner admission. No client identity or
            // admission coordinate is accepted from the request or JWT payload.
            return {
              issuer: config.access!.admissionIssuer,
              subject: config.access!.admissionSubject,
              connectionId: 'shared-ai',
              clientId: 'shared-ai',
            };
          },
        }),
    resolveAccess: (principal) => runtime.access.resolve(principal),
    service,
    ready: () => runtime.checkReady(),
    log,
  });
  return {
    listener,
    runtime,
    close: async () => {
      await service.close();
      await runtime.close();
    },
  };
}
