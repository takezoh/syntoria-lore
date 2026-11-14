import type { JWTVerifyGetKey } from 'jose';
import type { RequestListener } from 'node:http';
import {
  createMemoryRecordsRuntime,
  ObservationService,
  SHARED_AI_CONNECTION,
  type EmbeddingProvider,
  type RecallAssessor,
  type MemoryRecordsRuntime,
} from '@memory/memory-records';
import type { ApiConfig } from './config.js';
import { createEmbeddingProvider } from './embeddings.js';
import { VertexRecallAssessor } from './recall-assessment.js';
import { createAccessVerifier } from './access.js';
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
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

/** Wires the Firestore runtime, the memory service, Access verification and the HTTP listener. */
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
  const accessVerifier = createAccessVerifier(config.access, overrides.accessKeys);
  const listener = createRequestListener({
    mcpResourceUrl: config.mcpResourceUrl,
    mcpAllowedHosts: config.mcpAllowedHosts,
    authenticateAssertion: async (assertion, connectionId) => {
      await accessVerifier.authenticate(assertion);
      // The mapping selects an existing owner admission. No admission coordinate is accepted
      // from the request or JWT payload; the path selects only which of the admission's
      // connections is used, and an unprovisioned connection is denied by MemoryAccess.
      return {
        issuer: config.access.admissionIssuer,
        subject: config.access.admissionSubject,
        connectionId: connectionId ?? SHARED_AI_CONNECTION,
        clientId: SHARED_AI_CONNECTION,
      };
    },
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
