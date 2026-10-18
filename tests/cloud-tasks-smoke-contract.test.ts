import { describe, expect, it, vi } from 'vitest';
import { verifyDuplicateWorkerSweeps } from '../scripts/cloud-tasks-smoke-contract.mjs';

const sweepMetrics = {
  outbox: { dispatched: 0, retrying: 0 },
  due_jobs: 0,
  governance: { purged: 0, pending: 0 },
  portability: { exports: 0, failed: 0 },
};

describe('cloud Tasks smoke duplicate worker sweep contract', () => {
  it('waits for each authenticated target sweep result before checking terminal state', async () => {
    const events: string[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      events.push(`start-${calls}`);
      expect(String(input)).toBe('https://worker.example.test/internal/dispatch/sweep');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'t'.repeat(40)}`);
      expect(init?.body).toBe('{}');
      await Promise.resolve();
      events.push(`complete-${calls}`);
      return new Response(JSON.stringify(sweepMetrics), { status: 200 });
    };
    const readCaptureStatus = vi.fn(async () => {
      events.push('status');
      return 'committed';
    });

    const result = await verifyDuplicateWorkerSweeps({
      workerUrl: 'https://worker.example.test',
      workerIdToken: 't'.repeat(40),
      timeoutMs: 1_000,
      expectedCaptureStatus: 'committed',
      readCaptureStatus,
      fetchImpl,
    });

    expect(events).toEqual(['start-1', 'complete-1', 'status', 'start-2', 'complete-2', 'status']);
    expect(readCaptureStatus).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result.map((sweep) => sweep.metrics)).toEqual([sweepMetrics, sweepMetrics]);
    expect(result.map((sweep) => sweep.capture_status)).toEqual(['committed', 'committed']);
  });

  it('rejects HTTP success without a completed sweep result', async () => {
    const readCaptureStatus = vi.fn(async () => 'committed');
    const fetchImpl: typeof fetch = async () => new Response('{}', { status: 200 });

    await expect(
      verifyDuplicateWorkerSweeps({
        workerUrl: 'https://worker.example.test',
        workerIdToken: 't'.repeat(40),
        timeoutMs: 1_000,
        expectedCaptureStatus: 'committed',
        readCaptureStatus,
        fetchImpl,
      }),
    ).rejects.toThrow('omitted its completed sweep metrics');
    expect(readCaptureStatus).not.toHaveBeenCalled();
  });

  it('rejects a terminal state change after either completed sweep', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(sweepMetrics), { status: 200 });
    };
    const readCaptureStatus = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('committed')
      .mockResolvedValueOnce('processing');

    await expect(
      verifyDuplicateWorkerSweeps({
        workerUrl: 'https://worker.example.test',
        workerIdToken: 't'.repeat(40),
        timeoutMs: 1_000,
        expectedCaptureStatus: 'committed',
        readCaptureStatus,
        fetchImpl,
      }),
    ).rejects.toThrow('changed the terminal capture state');
    expect(calls).toBe(2);
    expect(readCaptureStatus).toHaveBeenCalledTimes(2);
  });
});
