# Memory compartments production release

## Outcome

On 2026-10-30, migrations 0049 to 0052 were applied, and Lore API revision `lore-api-cmp-57b7e6e` and worker revision `lore-worker-cmp-57b7e6e` began serving 100% of traffic. Memories are now labeled with compartments, and each Gate connection reads and writes within its own allowance ([ADR 0006](../adr/0006-enforce-disclosure-with-compartments-and-connection-allowances.md)), enforced in the services and by restrictive RLS policies. Every record that existed before the release is in the reserved Unclassified compartment, and no connection holds it yet, so existing connections see only General records until they request it. The owner authorized the deployment, including a brief API outage for the write fence, on 2026-10-30. Private origins, identity values and credential payloads are not included here.

## Source and artifacts

| Component | Source commit | Active revision or execution | Image digest |
| --- | --- | --- | --- |
| API | `b66aea9` | `lore-api-cmp-57b7e6e` | `sha256:60f493b4ddabf73008fa85b729ef9c124ae29d8c7734d3801bcd16e8c530af31` |
| Worker | `b66aea9` | `lore-worker-cmp-57b7e6e` | same image |
| Migration job | `b66aea9` | `lore-neon-migrate-l7dt7` | same image |
| Ledger reconcile job | `b66aea9` | not executed | same image |

- Revision names keep the abbreviated hash the source commit had before the [history rewrite](../technical/deployment.md#release-and-recovery) later the same day.
- Cloud Build `7f090b0a-da04-488a-be38-4d72310dd243` built the image from an immutable source snapshot of 208 allowlisted files with manifest SHA-256 `49b3dc23565df69f41f39b51a3b27edceeed9271940f61f43da1e1dd0d76c6c2`.
- The worker had run the 2026-10-18 image; this release moves it to the current source together with the API, because migration 0051 removes the label defaults that an older image relies on.

## Rollout

1. Both services received their new revision without traffic, the API with a temporary tag. Both started and passed their readiness probe, which checks the database connection and, for the worker, deletion-ledger readiness. Before migration the tagged API returned `/readyz` 200 and `GET /v1/access` 401 without a credential.
2. Both jobs were moved to the new image. The capture queue was running with no tasks.
3. The API and worker were fenced with manual scaling at zero instances; the public origin returned 503 for `/readyz`. An earlier attempt in the same session fenced only the worker and returned it to automatic scaling before the API fence was authorized; no task was queued at the time.
4. Execution `lore-neon-migrate-l7dt7` (14:07:27 to 14:07:38 UTC) applied `0049_memory_compartments.sql` to `0052_compartment_visibility.sql` and reported `migration_count=52`, `reapply=passed`, `status=migrated`, non-bypass application and worker roles, worker membership and revoked helper schema creation.
5. Traffic moved to the new revisions, both services returned to automatic scaling, and the API tag was removed.

Afterwards both services keep their previous runtime identity, environment, secret references, instance limits, concurrency and timeouts; only the image changed. The worker's invoker policy still names exactly two members and no public member. Gate, DNS, IAM, the capture queue, Scheduler and secret versions were not changed.

## Hosted checks

On the public origin after traffic moved, at 14:09 UTC:

- `/readyz` 200 with `Strict-Transport-Security: max-age=31536000`.
- `GET /v1/access` 401 without a credential and with a forged bearer; `GET /v1/changes` and `POST /v1/compartments` 401 with a forged bearer.
- MCP POST 401 without a credential and with a forged bearer, each with the resource metadata challenge; MCP GET 405; MCP resource metadata 200.
- `/openapi.json` 200 and lists `/v1/access`, `/v1/compartments`, `/v1/access:narrow` and `/v1/access:request`.
- Anonymous worker request 403.
- A Scheduler sweep at 14:09:03 UTC returned 200 from the new worker revision. Warnings logged by the new revisions up to the check were only the probes above.

## Limits

- These probes establish readiness, the new routes and negative authentication only. No authenticated hosted operation ran: creating a compartment, a labeled write, a widening by policy, a narrowing and the hiding of other connections' records are verified only against local PostgreSQL ([verification record](memory-compartments-enforcement-20261030.md)).
- Allowances, labels and the Unclassified compartment were not read back from the production database; the migration credential stays with the owner.
- The ledger reconcile job was moved to the new image but not executed; running it was not permitted in this session. The new worker's readiness probe checks deletion-ledger readiness.
- The policy overhead requirement NFR-1 has not been measured.

## Rollback

- No image-only rollback exists. An image from before 0051 fails every insert into a labeled table, and under 0052 it sets no compartment context and sees only General records. The previous API revision `lore-api-mcp-8a0441f` and worker revision `lore-worker-gate-20261018` must not receive traffic again.
- Repair forward with a new migration or image. Withdrawing database enforcement means a new migration that drops the `compartment_visibility` policies; it reopens every labeled row to every connection of the user and is the owner's decision.
- The previous migration job image is `sha256:d84fea48481fe10561ab8b91607f5891982633aed93fe19aed33f457aacaafc9` and the previous ledger reconcile job image is `sha256:d9a81c7838dd59dd72ae5e0f32dc7de102daf8910377a9e44df6ce5872ac3ae7`; neither matches the current schema.
