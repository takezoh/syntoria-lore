export interface VerifiedWorkerSweep {
  attempt: number;
  worker_status: number;
  elapsed_ms: number;
  metrics: {
    outbox: { dispatched: number; retrying: number };
    due_jobs: number;
    governance: Record<string, number>;
    portability: Record<string, number>;
  };
  capture_status: 'committed' | 'held';
}

export function verifyDuplicateWorkerSweeps(options: {
  workerUrl: string | URL;
  workerIdToken: string;
  timeoutMs: number;
  expectedCaptureStatus: 'committed' | 'held';
  readCaptureStatus: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedWorkerSweep[]>;
