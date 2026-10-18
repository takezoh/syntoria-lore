---
id: adr-0001-gcp-cloud-run-neon
kind: adr
title: Run the memory service on GCP Cloud Run and Neon PostgreSQL
status: accepted
created: '2026-10-14'
decision_makers: []
relations:
- {type: supersedes, target: Cloudflare Workers, Queues, Cron and Neon baseline (Architecture v1.0)}
summary: Run API and private worker on Cloud Run with Cloud Tasks and Cloud Scheduler, keep all memory state in Neon PostgreSQL, and choose model providers through an adapter.
---

# Run the memory service on GCP Cloud Run and Neon PostgreSQL

## Decision

The memory service (then named Thymesis, now Syntoria Lore) runs on GCP Cloud Run with Neon PostgreSQL. The [product contract](../design/requirements.md) is unchanged by this decision.

| Concern | Adopted |
| --- | --- |
| API and Remote MCP | Cloud Run service with application OAuth authorization |
| Curator and asynchronous handlers | Private Cloud Run service invoked with service-account OIDC and IAM |
| Job dispatch | Cloud Tasks authenticated HTTP tasks with bounded retries |
| Periodic recovery | Cloud Scheduler calling an OIDC-protected endpoint |
| Database-to-task propagation | Transactional outbox in PostgreSQL |
| Long-running bulk work | Cloud Run Jobs, only when a task deadline is insufficient |
| Source of truth | Neon PostgreSQL over TLS |
| Vector, lexical and relational search | pgvector, pg_trgm and relational edges in the same database |
| Language | TypeScript on Node.js with shared domain modules |
| Operations | Secret Manager, IAM, Cloud Logging and Monitoring, declarative configuration |
| Models | Provider-agnostic adapter over external APIs |

Neon is the only source of truth. Cloud SQL, Railway PostgreSQL, D1, a dedicated graph database and a dedicated vector database are not part of the topology.

## Requirements and rationale

The service needs synchronous remember and recall, long-running model curation, batch reprocessing, update history and change retrieval, Forget, and consistent recovery. The goal is a service that meets those requirements, not a comparison of clouds or databases.

The earlier Cloudflare Workers baseline offered low fixed cost and low operational load. It was re-evaluated in favor of one Node.js container environment for API and model work, room for long reprocessing and batches, existing Cloud Run operating experience, and easier measurement of SLOs and cost.

| Alternative | Decision basis |
| --- | --- |
| Cloudflare Workers, Queues and Cron | Very low operational load, but Cloud Run and Cloud Run Jobs give ordinary containers for heavy or long curation, and existing GCP experience applies |
| AWS Lambda, SQS and EventBridge | Meets the functional requirements; existing GCP assets and experience take priority for personal operation |
| Railway services and worker with Neon | Simple deployment; Cloud Tasks and Scheduler execution control and scale-to-zero were preferred |
| Railway PostgreSQL | Backup, PITR and specialist database operation are delegated to Neon |
| GCP Cloud SQL | Keeps everything in one cloud, but Neon was chosen on fixed cost and operability for the expected load |
| Cloudflare D1 and Vectorize | History, relations and semantic search stay in one PostgreSQL rather than several stores |

This is a qualitative operating judgment. It does not claim GCP is always cheapest or fastest; pricing and region availability are confirmed at deployment.

## Constraints

- Cloud Tasks HTTP targets have a dispatch deadline of at most 30 minutes (10 by default), unlike the 60-minute Cloud Run request limit. Work that cannot finish is split and checkpointed in the database, or run as a Cloud Run Job.
- Cloud Tasks is not exactly-once. The worker is idempotent per `job_id` and returns 2xx only after a durable result. There is no distributed transaction between the database and Cloud Tasks: observations and outbox rows commit together and resending must be safe.
- No native dead-letter queue is assumed. The database holds failed, held and next-retry state, and Cloud Scheduler recovers it. Task bodies carry only a job ID; content is read from Neon after authorization.
- The public API is an OAuth resource server. The worker accepts only dedicated task and scheduler identities; their service accounts carry no owner authority.
- Neon access uses least-privilege roles, forced row-level security with transaction-local context, TLS and bounded pools sized against Neon's connection limit.
- Forget is split into immediate denial and asynchronous purge, and the deletion ledger is reapplied after a database restore.
- Region is chosen from Neon's actual regions and providers, keeping the API close to the database and meeting data-residency needs; Tokyo was the first candidate for Cloud Run if Neon allowed it.
- Total cost includes GCP–Neon latency and transfer, Neon compute and storage, Cloud Run time, Cloud Tasks and Scheduler, and model tokens. Cloud Run starts at zero minimum instances and is adjusted only if cold start breaks the recall p95 target.

## Consequences

**Positive:** ordinary Node.js execution, independent scaling of HTTP and job processing, authenticated asynchronous execution managed by GCP, and one source of truth in Neon.

**Negative:** two providers to operate, cross-provider traffic, task deadlines, and an outbox dispatcher and failure recovery to design and verify.

**Non-goal:** adding other queues, graph or vector databases before the finished product shows a need. Technology migration is not a goal.

## Confirmation

Before Release 1, verify that jobs survive the task deadline, retry exhaustion, duplicate Scheduler runs and outbox resends; that task and scheduler IAM stays separate from user OAuth and owner scope; that row-level security context does not leak across pooled requests; p95 and actual cost for cold start, Neon round trip and the 100k–1m memory workload; and that model switching, purge of forgotten data and backup restore work in practice.

At decision time this was an adopted design without deployment or benchmarks. The deployment later placed Cloud Run and Vertex AI in `asia-southeast1` next to Neon in AWS `ap-southeast-1`. Current hosted evidence and open gates are in the [cloud verification register](../eval/cloud-verification.md); the resulting topology is in [infrastructure](../technical/infrastructure.md).

## Sources

- https://cloud.google.com/tasks/docs/creating-http-target-tasks
- https://cloud.google.com/tasks/docs/configuring-queues
- https://cloud.google.com/run/docs/configuring/request-timeout
- https://cloud.google.com/run/docs/create-jobs
- https://cloud.google.com/scheduler/docs/http-target-auth
- https://neon.tech/docs/connect/connection-pooling
