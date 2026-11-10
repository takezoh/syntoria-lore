---
id: adr-0007-store-memories-as-firestore-memory-records
kind: adr
title: Store memories as Memory Records in Firestore
status: accepted
created: '2026-11-08'
decision_makers:
- owner
relations:
- {type: references, target: adr-0001-gcp-cloud-run-neon}
- {type: references, target: adr-0006-enforce-disclosure-with-compartments-and-connection-allowances}
- {type: references, target: adr-0008-keep-a-generative-baseline-and-enable-decision-models-per-point}
summary: Make one Memory Record per reusable memory, with separate revision documents, the source of truth in Cloud Firestore (Standard edition, Native mode), keep originals in their own services, and replace the PostgreSQL row-level backstop with one authorized repository boundary.
---

# Store memories as Memory Records in Firestore

## Decision

On 2026-11-08 the owner directed work to proceed on the Memory Records plan, version 2.0 of that day, which carries forward the earlier choice of Firestore. Its first step is to fix the contracts and evaluation conditions; its second step starts the Firestore storage and the baseline path. This ADR records the storage part of that plan. The [Memory Records design](../design/memory-records.md) turns it into contracts. The owner accepted this record on 2026-11-09.

1. **One record per reusable memory.** A Memory Record holds one reusable statement (a decision with its question, choice and reason; an experience with its condition, action and outcome), its kind, subjects, applicability, source references, attribution, approval provenance, disclosure label, valid interval, recorded time and revision. The current record is one document; each revision is a separate document. History is not replayed to read the current state, and nothing grows without a bound inside one document.
2. **Firestore is the future source of truth.** The starting point is Cloud Firestore Standard edition in Native mode. Revisions, change log, idempotency records, deletion and processing state live next to the records. Embeddings are derived data with the record revision and model version attached.
3. **Originals stay where they are.** Google Drive, Notion, Gmail and other services keep documents, mail, PDFs, images and video. Lore keeps the provider, account, resource ID, URI, locator, available version and rights, plus the curated memory. Observation bodies are processed transiently and are not persisted. Migration never silently drops an observation that is the only copy of its content; such data is held for the owner's decision.
4. **One authorized repository boundary replaces the SQL backstop.** Firestore server clients bypass Security Rules, so Rules are not a substitute for PostgreSQL row-level security. Every read and write goes through one shared data-access layer that requires a verified actor capability, rechecks grants, scope epochs, connection allowance, source rights and suppression, and denies when any of them is unknown. Raw client handles stay private to that layer. Compartment labels, connection allowances, approval policies and deny-by-default semantics from [ADR 0006](0006-enforce-disclosure-with-compartments-and-connection-allowances.md) remain; only the PostgreSQL enforcement mechanism changes.
5. **Commits stay atomic and explicit.** A Firestore transaction checks expected revisions, authorization epochs, suppression and the idempotency key, then writes the record, revision, change-log entry, sequence and job intent together. Model calls, embedding generation and source fetches happen outside it.
6. **Forget acknowledges only what survives a restore.** A Forget reports that use has stopped only after the local suppression and the independent deletion ledger entry are both durable.
7. **What this does not change.** Cloud Run, Cloud Tasks, Cloud Scheduler, REST and Remote MCP, Gate and the shared domain packages remain. No cutover, data migration, deployment or deletion of existing data is decided here; each needs its own approval after the acceptance tests in the design pass.

When a cutover is approved, this decision replaces the PostgreSQL source-of-truth, search-index and outbox parts of [ADR 0001](0001-gcp-cloud-run-neon.md) and the RLS backstop of ADR 0006. Until then both stay in force for the running service.

## Requirements and rationale

The plan aims to keep the value of the current service (evidence, attribution, two-time history, approvals, change feed, Forget and compartments) while organizing storage around the memory itself rather than around many normalized tables and stored observation text.

Facts that shaped the decision:

- The current service stores memories, versions, evidence, observations, relations and indexes in PostgreSQL and enforces tenant and compartment visibility with forced row-level security ([data model](../technical/data-model.md)).
- Firestore supports atomic multi-document transactions, retries transaction functions on contention, limits a document to 1 MiB, provides vector search over externally generated embeddings, and has no general full-text search in Standard edition. Its server clients bypass Security Rules.
- Firestore triggers can deliver events more than once and out of order.

| Alternative | Decision basis |
| --- | --- |
| Keep PostgreSQL with RLS | Keeps the current independent backstop, but does not implement the storage model the owner adopted |
| Mirror the existing tables as Firestore collections | Rejected: moves complexity without organizing it around the memory |
| Memory Records with separate revisions in Firestore (chosen) | One unit of meaning per record, bounded documents, explicit history and an atomic commit path |
| Persist observation bodies or an archive of originals | Rejected: the originals already live in their services, and a copy widens what Forget and rights changes must reach |
| Rely on Firestore Security Rules for tenant isolation | Rejected: server clients bypass them |

## Consequences

- **Security and authorization.** The independent SQL query backstop is lost. A missed filter in application code could disclose data. Mitigations are mandatory before any integration: one repository boundary that is the only holder of the client, a check that rejects direct client use elsewhere, and contract tests over every surface (direct reads, recall, relations, history, idempotent replay, change feed, confirmations and export) including revocation between candidate selection and response.
- **Data.** A record, its revisions and its source references replace memories, versions, evidence and observation text. Record content, sources, relations and search terms have application limits; content over a limit is split explicitly, never truncated silently.
- **Migration.** Forward-only and staged: inventory, isolated transformation with semantic comparison, read comparison with the old side as the only writer, an approved write fence and a single-writer switch. A rollback after new writes requires replaying those writes or stopping writes and reconciling; a blind restore of the old database is not a rollback.
- **Forget and restore.** Suppression, the content-free deletion record and the independent ledger remain. A restored database stays closed until every durable ledger entry is applied. Firestore does not delete subcollections with their parent, so purge verifies that revisions and management data are gone.
- **Search.** Lexical matching becomes normalized terms and aliases plus vector search; it is not general full-text search. If acceptance fails for names, aliases, keywords or Japanese, the first candidate is Enterprise edition text search, checked for availability, region, SDK, rights filtering, cost and Japanese results.
- **Operations.** Reads, writes, index lag, conflicts, pending and failed jobs, source reference errors and incomplete deletions are monitored. Costs include Firestore operations, storage and indexes; a free tier is not a cost guarantee.

## Confirmation

The [design's acceptance scenarios](../design/memory-records.md#acceptance-scenarios) must pass against the Firestore emulator for local behavior and against a real project for IAM, managed transactions, restore, latency and cost. Required checks include racing updates with one winner, idempotent retries, gap-free change feeds, revocation during recall, restore of a backup taken before a Forget while the ledger is unavailable, and every surface returning nothing outside the connection's allowance. This ADR is not evidence of implemented or deployed behavior; on 2026-11-08 nothing had been implemented against Firestore.

## Sources

- The owner's direction of 2026-11-08 to proceed with the Memory Records plan v2.0, and the owner's answer to start step 2 as well
- [Memory Records design](../design/memory-records.md), [data model](../technical/data-model.md), [memory system](../technical/memory-system.md), [ADR 0001](0001-gcp-cloud-run-neon.md), [ADR 0006](0006-enforce-disclosure-with-compartments-and-connection-allowances.md)
- https://firebase.google.com/docs/firestore/manage-data/transactions
- https://firebase.google.com/docs/firestore/quotas
- https://firebase.google.com/docs/firestore/vector-search
- https://docs.cloud.google.com/firestore/native/docs/editions-overview
- https://firebase.google.com/docs/firestore/enterprise/text-search
- https://firebase.google.com/docs/functions/firestore-events#limitations
- https://firebase.google.com/docs/firestore/security/rules-conditions
- https://firebase.google.com/docs/firestore/manage-data/delete-data
