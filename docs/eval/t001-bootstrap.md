# T-001 Repository bootstrap evidence

T-001 adds a reproducible npm workspace bootstrap for the API, worker, and shared runtime. The implementation is in the working tree; the checks below were recorded for this candidate. Independent review is pending.

## Environment and install

- Node.js: `v24.16.0`
- npm: `11.13.0`
- No repository `.env` file was present; local defaults were used.
- `npm ci --no-audit --no-fund` — passed (exit code 0; 136 lockfile packages installed).

## Checks

| Command | Result |
| --- | --- |
| `npm run format:check` | Passed; matched source, configuration, and package manifests follow Prettier formatting. |
| `npm run lint` | Passed; ESLint reported no findings. |
| `npm run typecheck` | Passed; workspace project builds and no-emit checks for tests and Vitest configuration completed. |
| `npm test` | Passed; 1 test file and 13 tests, covering API/worker HTTP behavior, malformed requests, unknown routes, and port validation. |
| `npm run build` | Passed; all referenced TypeScript workspaces built. |

## HTTP startup probes

| Service | Command | Request | Result |
| --- | --- | --- | --- |
| API | `npm run start:api` | `curl -fsS -i http://127.0.0.1:8080/healthz` | HTTP 200, `{"status":"ok"}`; process stopped after response. |
| Worker | `npm run start:worker` | `curl -fsS -i http://127.0.0.1:8081/healthz` | HTTP 200, `{"status":"ok"}`; process stopped after response. |

The recorded processes bound to `0.0.0.0:8080` and `0.0.0.0:8081`, respectively. No external service or production credential was used.

## Scope and remaining work

These results cover the T-001 bootstrap only. The API and worker expose only the minimal `GET /healthz` route; product APIs, authentication, database and queue behavior, and fake LLM behavior are not implemented. Local PostgreSQL/Cloud Tasks/Scheduler stubs and integrated startup remain T-002; CI pipeline work remains T-003. G0 also requires the later contract, database, migration/rollback, and CI acceptance work, so this evidence does not mark G0 complete.

This report records the verification evidence retained with the prior T-001 pursuit. Commands were not rerun while preparing this report.
