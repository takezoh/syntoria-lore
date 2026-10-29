---
id: adr-0003-attribute-ai-clients-and-confirm-user-decisions
kind: adr
title: Grant user authority only from the person's approval, not per AI client
status: proposed
created: '2026-10-20'
decision_makers: []
relations:
- {type: references, target: adr-0002-local-contract-core}
summary: All AI connections of an admitted person share one non-user principal, the AI's client ID is recorded only as provenance, and user authority is exercised only by committing a change the person approved at Gate.
---

# Grant user authority only from the person's approval, not per AI client

## Decision

Proposed on 2026-10-20; not yet accepted. Stages 1 to 3 are in production since 2026-10-29, with the switch set for the single production binding. The owner decided that authorization does not depend on which AI makes a request; it depends on whether the person approved. Approving a Gate connection lets an AI read and propose within the admitted scopes. A user decision or a governance operation needs the person's approval of that specific change.

Lore would adopt three rules:

1. **No per-AI authorization.** The operator still admits a Gate issuer and subject through `external_identity_bindings`. Every approved connection of that subject acts as one non-user principal that belongs to the person, whichever AI holds the connection. Lore records the Gate `client_id` with each write as provenance, so the person can see which AI proposed what. No grant, ceiling or rule depends on it.
2. **AI requests carry no user authority.** Because that principal is not a user, existing core rules apply unchanged: its writes receive `ai_proposal` authority and remain candidates, and it cannot supersede, retract or refine user-attributed memories, decide reviews, Forget, change source rights, grants or retention, export or import.
3. **User authority needs the person's approval of the exact change.** An AI may request a user decision or a governance operation. Lore stores the exact pending change, creates a Gate confirmation bound to a hash of it and renders the summary itself; the AI cannot supply that text. Lore gives the AI a Gate URL to show the person. The person signs in at Gate and approves or denies. Lore then checks the result online with its resource credentials and commits the stored change once, as the person's user principal.

Rule 3 requires a new Gate contract: a resource-authenticated endpoint that creates a confirmation, a signed-in approval page, and a resource-authenticated status check. A confirmation belongs to the resource that created it and to the subject it names: Gate shows it only to that signed-in subject and reports its result only to that resource. Gate displays the resource-supplied summary but does not interpret memory semantics.

## Requirements and rationale

AC-01 requires that an AI recommendation is never stored or returned as a user decision. Since migration 0043, Lore selects the principal by Gate issuer and subject only, and every approved connection acts with that principal's actor kind. When that principal is a user, an AI records user authority unless it sends `epistemic_status: "proposed"`, and it can call the Forget, grant, source-rights, retention, export and import tools directly. AC-01 then depends on client cooperation, and an AI that is misled by injected content, or a client approved by mistake, can run destructive operations the person never approved. The integration test that covers AC-01 uses a separate Gate subject, which does not match how a person actually connects an AI.

Connection approval cannot tell whether the person wanted a specific change: it happens once per connection, before the change exists. Per-AI principals or permissions cannot tell either, because an AI the person trusts can still be misled. Only the person's approval of the change itself separates a user decision from an AI recommendation.

| Alternative | Decision basis |
| --- | --- |
| Keep subject-level user authority and rely on `"proposed"` | Rejected as the end state: AC-01 and governance safety depend on each client following tool guidance |
| Per-AI principals, grants or trust levels | Rejected by the owner: authorization follows the person's approval, not the AI's identity |
| Merge registrations by client name or redirect URI | Rejected: names are unverified, and the same product on different devices registers identical metadata |
| Confirm through MCP elicitation | Rejected for authority: the answer passes through the AI client, so Lore cannot tell a person's answer from a fabricated one |
| Restore a Lore browser page using the Gate browser session | Possible, but it reverses the 2026-10-19 API-only decision and adds a browser surface and CSRF boundary to Lore |
| Gate-hosted confirmation (proposed) | Keeps Lore API-only, reuses Gate's sign-in, Origin and CSRF controls, and can serve Weave as well |

Limits of the guarantee, judgment rather than measurement: a confirmation shows that the person's signed-in Gate session approved this exact change at Gate. It does not show that the person read the summary. It also does not exclude an AI that controls the person's signed-in browser through browser automation. On 2026-10-28 the owner decided not to require user verification, such as a passkey, at approval and accepted this limit.

## Consequences

- **Behavior.** A remembered decision or preference from any AI is a candidate until the person approves it. "Explain it once" gains one approval step for user decisions and preferences, and each Forget or other governance operation gains one approval. Recall must keep showing candidates as proposals.
- **Attribution.** All AIs of one person share the non-user principal, so any of them can revise candidates another one proposed. The recorded `client_id` tells them apart for the person, not for authorization.
- **Authorization.** `app.lock_actor_access` ties the actor kind to the principal row, so requests over a connection and confirmed commits use two principals of the same person: the shared non-user principal and the user principal. The binding names both. Revoking the Gate connection, deactivating the binding or expiring a grant must still deny on the next request and at the final pre-commit check, including the commit of a confirmed change.
- **Data and migration.** A forward-only migration adds the non-user principal for each admitted subject and a provenance column for `client_id`. The `principals` table requires a unique issuer and subject, so the non-user principal receives a synthetic pair in a namespace the authenticator never accepts; no Gate token can resolve to it directly. Existing memories keep their current attribution and are not backfilled, because their client is unknown.
- **Abuse limits.** Pending confirmations per subject are bounded and expire, so an AI cannot flood the person with approval requests.
- **Export and import.** Lore is one environment shared by every AI and device, so export and import are not offered through confirmations and stay unavailable to AI connections.
- **Cursors and idempotency.** Both bind the principal, so all AIs of one person share one cursor and idempotency namespace, as they do today.
- **Gate.** A new confirmation contract, storage with expiry and single use, an approval page and SDK support are needed. Weave may adopt them later.

## Confirmation

Proposed staging, each stage reversible:

1. Record `client_id` provenance on writes. Authorization is unchanged.
2. Add the Gate confirmation contract and Lore's confirmation flow.
3. Switch requests over Gate connections to the non-user principal, which enforces AC-01 and governance approval in Lore. The switch is one binding field, so clearing it reverts.

The contracts, requirements and implementation units are in the [change confirmation design](../design/change-confirmation.md).

Checks to add: two clients of one subject act as the same non-user principal with different recorded `client_id`; a write over a connection is `ai_proposal` regardless of `epistemic_status`; a governance tool over a connection creates a confirmation instead of running; a confirmed change commits once as the user principal; a replayed, denied, expired or modified confirmation is rejected, as is one approved by another subject or created by another resource; revocation still denies at commit. As of 2026-10-29, stages 1 and 2 and the code for stage 3, including the identity-mapping tool that sets and clears the switch, are implemented locally and pass these checks against PostgreSQL and the Firestore Emulator. On 2026-10-29 Gate and Lore were released with this code (see the [change confirmation release record](../eval/change-confirmation-release-20261029.md)); the switch was then set for the single production binding, whose principal is a user principal. Reading the production principal before stage 3 confirmed that confirmed commits reach the person's user principal.

## Sources

- Owner direction on 2026-10-20: one AI is one installation; authorization is not per AI and follows whether the person approved; proceed with Gate registration expiry and this Lore design.
- [Requirements AC-01](../design/requirements.md#acceptance-contracts), [data model authority rules](../technical/data-model.md#authority-and-attribution) and [MCP authorization](../technical/mcp-api.md#entry-points-and-authorization).
- `packages/auth/src/index.ts` and migration `0043_subject_identity_admission.sql`: principal selection by issuer and subject.
- Migration `0007_grant_expiry_and_immutable_versions.sql` (`app.lock_actor_access`): the actor kind must match the principal row.
- `packages/domain/src/core-service.ts` (`deriveAuthority`) and the AC-01 case in `tests/core.postgres.test.ts`.
- [DCR production release record](../eval/dcr-production-release-20261020.md).
