# Security boundaries

This document records Lore's assets, actors and trust boundaries, the controls that enforce them and the limits of current evidence. It is a design and verification reference, not an external audit.

## Assets and actors

Assets are private memories and their evidence, identities and grants, source rights and consent, change cursors, signing and encryption keys, export artifacts and the deletion ledger. Actors are the owner, separately granted AI clients (read-only or write-capable), capture sources whose content is untrusted, the curator and its model provider, task and scheduler senders, the private worker, operators with infrastructure access, and an attacker who can send HTTP or MCP requests, replay old inputs or plant instructions in captured content.

## Trust boundaries and controls

| Boundary | Threat | Control |
| --- | --- | --- |
| Authorization server → REST/MCP | Forged or expired token, wrong issuer or audience, resource confusion, read token used to write | JWKS signature, issuer, lifetime, exact resource audience and scope verification; separate `/mcp/read` and `/mcp/write` resources; read endpoint has no write tools; Host and Origin checks on MCP |
| Principal → tenant data | Scope crossing, stale grant, pooled-context leakage, privilege escalation | Token claims intersected with live grants and authorization epochs on every operation; transaction-local context; forced row-level security; non-superuser, `NOBYPASSRLS` runtime roles that own no tables |
| Source and model → curation | Prompt injection, authority spoofing, inflated evidence, old material overriding a current decision | Source text is data; proposals pass strict schema validation and exact evidence-anchor checks; authority derived in the core, never from model output; lineage-based evidence independence; owner review for decisions, preferences and conflicts |
| Outbox → worker | Forged task, duplicate delivery, stale lease causing repeated mutation | Worker reachable only through Cloud Run IAM from dedicated invoker identities; task body carries only a job ID; authorized scope reloaded from the database; persisted leases and checkpoints; idempotent retries |
| Source rights → derived memory | Revoked source still recalled or exported | Rights checked on every read with share locks; revocation advances the authorization epoch and invalidates ready exports |
| Forget → backup restore | Restored snapshot resurrects forgotten content | Deletion ledger outside the database; readiness compares database checkpoint with ledger head and fails closed; replay runs through the non-bypass worker role |
| Storage → artifacts and ledger | Disclosure, partial deletion, overwrite of history | Authenticated encryption for exports; generation-conditioned head updates; immutable ledger nodes; custom roles limited to required object actions; artifact bucket without versioning, with public access prevention |
| Logs and diagnostics → operators | Content, tokens or secrets in logs | Structured events with IDs, routes, statuses, durations and safe error classes only; provider errors are not logged verbatim; diagnostics return counts and checkpoint metadata |
| Identity service → public internet | Admin access, open registration, redirect abuse | Proxy allowlist of realm OAuth, JWKS and owner account routes; admin, master realm and client registration closed; exact redirect URIs; PKCE; no password grant |

## Secrets and operator access

Database URLs, the Forget HMAC key, the portability master key, cursor HMAC keys and identity credentials live in Secret Manager and are referenced by version. Each service account can read only its declared secrets; the migration credential never reaches a service. Operational access to infrastructure is separate from access to memory content; there is no administrator account that reads memories through the product.

## Evidence and remaining limits

Local evidence: the real-PostgreSQL suite covers row-level security, grant intersection and expiry, pooled-context reset, authority separation, source-rights races, append-only versions and fail-closed restore; the local smoke covers token audiences and read/write separation. Hosted evidence: private API and worker IAM, worker invoker bindings, the direct-IAM boundary gate, deployed PKCE and audience isolation, and Forget across owners have passed; see the [cloud verification register](../eval/cloud-verification.md).

Not yet established: inherited organization or folder IAM, Secret Manager key rotation, Neon network and point-in-time recovery behavior, cloud log retention, external-source connector authorization, rate limiting at scale, independent penetration testing and disaster-recovery objectives. Do not present local or smoke results as those claims.
