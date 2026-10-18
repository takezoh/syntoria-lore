import { describe, expect, it } from 'vitest';
import { runCloudOAuthBootstrap } from '../scripts/cloud-oauth-bootstrap.mjs';

const actions = ['configure', 'ensure-smoke-user', 'delete-smoke-user', 'rename-existing'] as const;

describe('Cloud OAuth bootstrap invocation', () => {
  it.each(actions)('dispatches the %s action to its Cloud Run Job', async (action) => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      requests.push({
        url,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const payload =
        method === 'POST'
          ? {
              name: 'projects/example/locations/us-central1/operations/op-1',
              done: true,
              response: {
                name: 'projects/example/locations/us-central1/jobs/identity/executions/run-1',
              },
            }
          : {
              conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }],
              failedCount: 0,
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await expect(
      runCloudOAuthBootstrap(
        action,
        {
          CLOUD_OAUTH_BOOTSTRAP_JOB: 'projects/example/locations/us-central1/jobs/identity',
        },
        {
          getAccessToken: async () => 'test-token',
          fetchImpl,
          pause: async () => undefined,
        },
      ),
    ).resolves.toEqual({ status: 'completed', action });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(
      'https://run.googleapis.com/v2/projects/example/locations/us-central1/jobs/identity:run',
    );
    expect(requests[0]?.body).toMatchObject({
      overrides: {
        containerOverrides: [
          { name: 'keycloak', env: [{ name: 'OAUTH_SMOKE_ACTION', value: action }] },
        ],
      },
    });
    expect(requests[1]?.url).toBe(
      'https://run.googleapis.com/v2/projects/example/locations/us-central1/jobs/identity/executions/run-1',
    );
  });
});
