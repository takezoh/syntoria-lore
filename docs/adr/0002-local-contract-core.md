---
id: adr-0002-local-contract-core
kind: adr
title: Establish the PostgreSQL contract core before capture and curation
status: accepted
created: '2026-10-14'
decision_makers: []
relations:
- {type: references, target: adr-0001-gcp-cloud-run-neon}
summary: Build the authoritative memory API on PostgreSQL first, with non-bypass runtime roles, separate proposal and commit, gap-free per-scope feeds and per-revision evidence.
---

# Establish the PostgreSQL contract core before capture and curation

## Decision

The authoritative memory API was built on PostgreSQL before capture, curation, hybrid retrieval and governance were integrated:

1. PostgreSQL is the source of truth. API work runs through a dedicated `NOSUPERUSER NOBYPASSRLS` login; each operation sets owner, principal and authorized scope context locally inside a transaction. The migration and test administrator is never the runtime identity.
2. Proposal and commit are separate. `POST /v1/changesets` validates and persists a proposal; `POST /v1/changesets/{id}:commit` rechecks access, source rights and expected revisions, then writes revisions, version evidence, relations, scope offset, change log, outbox, idempotency response and audit record atomically.
3. Change feed sequences are allocated under the scope offset row lock. Signed cursors bind owner, principal, exact scope vector, per-scope offsets and authorization epochs.
4. `memory_version_evidence` fixes each revision's evidence. Historical reads choose the latest revision recorded by `known_at`, then test that revision's valid-time interval; a later revision is never substituted because an older interval covers `valid_at`.
5. Context stays structured JSON. Relations are `supersedes`, `supports`, `contradicts`, `related_to`, `same_subject` and `depends_on_context`.
6. Source rows are share-locked while evidence-backed memories are read or committed, so revocation either wins before authorization or waits for the authorized transaction.

## Requirements and rationale

The core must keep owner and AI authority apart, isolate scopes, respect evidence rights, use optimistic concurrency and preserve both valid time and known time. A scaffold, or an API that committed a proposal immediately, would have erased those boundaries before the rest of the system could rely on them. Building later units on a verified core avoids retrofitting authorization and history into capture and curation.

## Consequences

Contract tests run against real PostgreSQL with signed JWTs from a local JWKS fixture; no request-header identity bypass exists. Later units built on these rules: pgvector columns and hybrid recall were added by forward migrations, and the non-precise recall modes, capture, curation, Forget and portability reuse the same transaction and authorization path. The current contract is described in the [data model](../technical/data-model.md).

## Confirmation

At decision time only precise recall existed, embeddings were a reserved `real[]` column, and the local stack, OAuth provider, capture, curation, task substitutes, governance and CI were not yet built. The [contract-core verification record](../eval/core-local.md) captures that milestone; the [local acceptance record](../eval/local-acceptance.md) covers the completed local implementation.

## Sources

- [Product requirements](../design/requirements.md)
- [Contract-core verification record](../eval/core-local.md)
