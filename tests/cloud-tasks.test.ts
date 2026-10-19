import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@memory/db';
import { CloudTasksTaskDispatcher, OutboxDispatcher } from '@memory/jobs';
import { createWorkerServer } from '../apps/worker/src/server.js';
import { createDispatchSweep } from '../apps/worker/src/sweep.js';
import { readCloudDeploymentConfig } from '../scripts/cloud-deployment-config.mjs';

const cloudDeployment = await readCloudDeploymentConfig();
const configuration = {
  projectId: cloudDeployment.project,
  location: cloudDeployment.region,
  queue: cloudDeployment.taskQueue.name,
  workerUrl: 'https://worker-abc-uc.a.run.app',
  taskInvokerServiceAccount: cloudDeployment.taskQueue.invokerServiceAccount,
};

describe('Cloud Tasks dispatch', () => {
  it('fails closed for incomplete or non-private cloud endpoint configuration', () => {
    expect(
      () =>
        new CloudTasksTaskDispatcher(
          { ...configuration, projectId: '' },
          async () => 'test-access-token',
        ),
    ).toThrow('CLOUD_TASKS_PROJECT_ID is invalid');
    expect(
      () =>
        new CloudTasksTaskDispatcher(
          { ...configuration, workerUrl: 'http://worker.internal' },
          async () => 'test-access-token',
        ),
    ).toThrow('WORKER_TASK_URL must be an HTTPS origin');
  });

  it('creates unique OIDC tasks with only the job UUID in the body and a 600 second deadline', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response('', { status: 200 });
    };
    const dispatcher = new CloudTasksTaskDispatcher(
      configuration,
      async () => 'test-access-token',
      fetchImpl,
    );
    const jobId = randomUUID();

    await dispatcher.dispatch(jobId, 'trace-id-is-not-task-content');
    await dispatcher.dispatch(jobId, 'trace-id-is-not-task-content');

    expect(requests).toHaveLength(2);
    const tasks = requests.map(({ url, init }) => {
      expect(url).toBe(
        `https://cloudtasks.googleapis.com/v2/projects/${configuration.projectId}/locations/${configuration.location}/queues/${configuration.queue}/tasks`,
      );
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-access-token');
      const request = JSON.parse(String(init.body)) as {
        task: {
          name: string;
          dispatchDeadline: string;
          httpRequest: {
            url: string;
            body: string;
            headers: Record<string, string>;
            oidcToken: { serviceAccountEmail: string; audience: string };
          };
        };
      };
      return request.task;
    });

    expect(new Set(tasks.map((task) => task.name)).size).toBe(2);
    for (const task of tasks) {
      expect(task.name).toMatch(
        new RegExp(
          `^projects/${configuration.projectId}/locations/${configuration.location}/queues/${configuration.queue}/tasks/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
          'i',
        ),
      );
      expect(task.dispatchDeadline).toBe('600s');
      expect(task.httpRequest).toMatchObject({
        url: 'https://worker-abc-uc.a.run.app/internal/jobs/run',
        headers: { 'Content-Type': 'application/json' },
        oidcToken: {
          serviceAccountEmail: configuration.taskInvokerServiceAccount,
          audience: 'https://worker-abc-uc.a.run.app',
        },
      });
      expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString('utf8'))).toEqual({
        job_id: jobId,
      });
    }
  });

  it('treats duplicate task names and API errors as failed dispatches for outbox retry', async () => {
    const jobId = randomUUID();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('claim_outbox_events'))
        return { rows: [{ event_id: randomUUID(), payload: { job_id: jobId } }] };
      return { rows: [], rowCount: 1 };
    });
    const client = {
      query,
      release: vi.fn(),
    };
    const database = {
      connect: vi.fn(async () => client),
      query,
    } as unknown as Database;
    const dispatcher = new OutboxDispatcher(database, {
      dispatch: vi.fn(async () => {
        throw new Error('Cloud Tasks create returned HTTP 409');
      }),
    });

    await expect(dispatcher.dispatchPending()).resolves.toEqual({ dispatched: 0, retrying: 1 });
    expect(query.mock.calls.some(([sql]) => sql.includes('complete_outbox_event'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('retry_outbox_event'))).toBe(true);
  });
});

describe('Cloud worker authorization and scheduler sweep', () => {
  it('keeps the legacy governance route disabled in cloud mode and preserves the scheduler route', async () => {
    const runGovernanceSweep = vi.fn(async () => ({ purged: 0, pending: 0 }));
    const runDispatchSweep = vi.fn(async () => ({ status: 'swept' }));
    const server = createWorkerServer({
      processor: { process: async (job_id) => ({ status: 'accepted', job_id }) },
      authorizeInternal: () => true,
      allowLocalGovernanceSweep: false,
      runGovernanceSweep,
      runDispatchSweep,
    });
    const baseUrl = await listen(server);

    try {
      const legacyResponse = await fetch(`${baseUrl}/internal/governance/sweep`, {
        method: 'POST',
      });
      expect(legacyResponse.status).toBe(404);
      expect(runGovernanceSweep).not.toHaveBeenCalled();

      const schedulerResponse = await fetch(`${baseUrl}/internal/dispatch/sweep`, {
        method: 'POST',
      });
      expect(schedulerResponse.status).toBe(200);
      expect(await schedulerResponse.json()).toEqual({ status: 'swept' });
      expect(runDispatchSweep).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it('preserves the local-token governance fixture behind the explicit local route gate', async () => {
    const taskToken = 'a'.repeat(32);
    const runGovernanceSweep = vi.fn(async () => ({ purged: 1, pending: 0 }));
    const runPortabilitySweep = vi.fn(async () => ({
      exports: 0,
      failed: 0,
      expired: 0,
      deleted_files: 0,
      file_deletions_pending: 0,
    }));
    const server = createWorkerServer({
      processor: { process: async (job_id) => ({ status: 'accepted', job_id }) },
      taskToken,
      allowLocalGovernanceSweep: true,
      runGovernanceSweep,
      runPortabilitySweep,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/internal/governance/sweep`, {
        method: 'POST',
        headers: { authorization: `Bearer ${taskToken}` },
      });
      expect(response.status).toBe(200);
      expect(runGovernanceSweep).toHaveBeenCalledTimes(2);
      expect(runPortabilitySweep).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it('does not accept task or identity headers when the injected platform authorizer denies access', async () => {
    const runDispatchSweep = vi.fn(async () => ({ status: 'ok' }));
    const server = createWorkerServer({
      processor: { process: async (job_id) => ({ status: 'accepted', job_id }) },
      authorizeInternal: () => false,
      runDispatchSweep,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/internal/dispatch/sweep`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer attacker-supplied-token',
          'x-cloudtasks-queuename': `projects/${configuration.projectId}/locations/${configuration.location}/queues/${configuration.queue}`,
          'x-serverless-authorization': 'Bearer attacker-supplied-token',
        },
      });
      expect(response.status).toBe(401);
      expect(runDispatchSweep).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('runs one fixed-size recovery pass per authenticated scheduler request', async () => {
    const dispatchPending = vi.fn(async () => ({ dispatched: 3, retrying: 1 }));
    const sweepDueJobs = vi.fn(async () => 4);
    let governancePass = 0;
    const runGovernanceSweep = vi.fn(async () => {
      governancePass += 1;
      return governancePass === 1
        ? { purged: 2, pending: 1, retention_pending: 3, retention_queued: 2 }
        : { purged: 1, pending: 0, retention_pending: 1, retention_queued: 1 };
    });
    const runPortabilitySweep = vi.fn(async () => ({ exports: 1, failed: 0 }));
    const sweep = createDispatchSweep({
      dispatchPending,
      sweepDueJobs,
      runGovernanceSweep,
      runPortabilitySweep,
    });

    await expect(sweep()).resolves.toEqual({
      outbox: { dispatched: 3, retrying: 1 },
      due_jobs: 4,
      governance: { purged: 3, pending: 0, retention_pending: 1, retention_queued: 3 },
      portability: { exports: 1, failed: 0 },
    });
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    expect(dispatchPending).toHaveBeenCalledWith(50);
    expect(sweepDueJobs).toHaveBeenCalledTimes(1);
    expect(sweepDueJobs).toHaveBeenCalledWith(100);
    expect(runGovernanceSweep).toHaveBeenCalledTimes(2);
    expect(runPortabilitySweep).toHaveBeenCalledTimes(1);
  });

  it('exposes the private scheduler route only through the injected authorization boundary', async () => {
    const runDispatchSweep = vi.fn(async () => ({ status: 'swept' }));
    const server = createWorkerServer({
      processor: { process: async (job_id) => ({ status: 'accepted', job_id }) },
      authorizeInternal: () => true,
      runDispatchSweep,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/internal/dispatch/sweep`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'swept' });
      expect(runDispatchSweep).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });
});

async function listen(server: ReturnType<typeof createWorkerServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Worker server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createWorkerServer>): Promise<void> {
  server.close();
  await once(server, 'close');
}
