---
id: adr-0004-approve-protected-changes-by-policy
kind: adr
title: Approve a connection's protected changes by a per-binding policy
status: proposed
created: '2026-10-29'
decision_makers:
- owner
relations:
- {type: references, target: adr-0003-attribute-ai-clients-and-confirm-user-decisions}
summary: Connections never act as the user principal; whether a protected change they request is applied at once or waits for the person at Gate is a recorded per-binding approval policy, auto by default and in production.
---

# Approve a connection's protected changes by a per-binding policy

## Decision

On 2026-10-29 the owner decided that AI operations must always be told apart from the person's, that how they are approved must be controllable, and that for now every request is approved automatically, in production as well.

1. **No connection acts as the person.** A Gate connection always resolves to a non-user principal. The binding of a user principal names a connection principal; a binding that would resolve to a user principal is refused. Migration 0048 gave every existing binding of a user principal its connection principal.
2. **Approval is a per-binding policy.** `external_identity_bindings.approval_policy` is `auto` or `gate`, set through the reviewed identity-mapping tool. Under `gate`, a protected change waits for the person's approval at Gate as in [ADR 0003](0003-attribute-ai-clients-and-confirm-user-decisions.md). Under `auto`, Lore applies it at once as the user principal.
3. **Every approval is recorded.** A policy-approved change is recorded in `change_confirmations` with `approval = 'policy'`, the requesting connection and client, and its outcome; a change approved at Gate has `approval = 'person'`. The response to the AI carries `approval.by = "policy"`.
4. **`auto` is the default.** New bindings use it, and migration 0048 sets it for every existing binding, including the production binding that asked the person at Gate since 2026-10-29.

This amends rule 3 of ADR 0003. Rules 1 and 2 stand: connection writes keep `ai_proposal` authority, and the connection principal still cannot supersede, retract, Forget or change governance itself.

## Requirements and rationale

The owner asked that AI and human operations be distinguished wherever they were not, with a controllable mechanism such as an approval flow, approving automatically for now. Before this decision the distinction and the approval were one switch: a binding without a connection principal let every AI act as the person, with user authority and no record that an AI did it, and naming one required the person's approval at Gate for every protected change.

| Alternative | Decision basis |
| --- | --- |
| Keep the switch (null connection principal means automatic) | Rejected: automatic operation would again record AI actions as the person's |
| Remove the null mode and keep Gate approval only | Rejected by the owner for now: it keeps the distinction but not automatic approval |
| Per-binding policy with a recorded policy approval (chosen) | Keeps the principal distinction always, makes approval controllable, and leaves an audit record of every automatic approval |
| Per-operation or per-client policies | Deferred: no current need, and ADR 0003 rejected per-AI authorization |

## Consequences

- **Authority.** Under `auto`, a decision, preference or correction an AI requests through `request_user_decision` receives user authority without the person seeing it. The memory and changeset name the user principal and the requesting client; whether the person or the policy approved it is recorded only in `change_confirmations`, not in Recall output. AC-01 now holds as "never without a recorded approval".
- **Governance.** Under `auto`, Forget, source consent, source rights, grants, retention and review decisions requested by an AI take effect without asking the person. A misled or misused AI can therefore make them; the record shows which connection asked.
- **Production.** Deploying migration 0048 switches the production binding from `gate` to `auto`. Setting `gate` restores per-change approval; an image from before 0048 ignores the policy and asks at Gate.
- **Authorization.** The policy is re-read at the final pre-commit check, so a request authenticated under the other policy fails and must be retried.
- **Operations.** `--connection-principal enable|disable` is replaced by `--approval auto|gate`; activation creates the connection principal.

## Confirmation

Checks: a connection under `auto` applies a protected change once, records `approval = 'policy'` with its connection and returns `approval.by = "policy"`; a repeated key returns the stored outcome and a different change with it is 409; requests without a key are applied anew; the connection's own writes stay `ai_proposal`; a binding resolving to a user principal is refused; `gate` keeps the ADR 0003 flow; migration 0048 backfills a connection principal for a user-principal binding and keeps an existing one. On 2026-10-29 these passed locally against PostgreSQL (`tests/core.postgres.test.ts`, 45 tests) together with an upgrade check of 0048 from a database at 0047. Migration 0048 and the API were released to production on 2026-10-29 ([release record](../eval/approval-policy-release-20261029.md)); the hosted probes cover readiness and authentication rejection only, and no policy approval has been observed in production.

## Sources

- Owner direction on 2026-10-29: distinguish AI and human operations where they are not, implement a controllable mechanism such as an approval flow, approve automatically for now, in both Weave and Lore; production also uses automatic approval.
- Migration `0048_connection_approval_policy.sql`, `packages/auth/src/index.ts`, `apps/api/src/confirmations.ts` and `scripts/gate-identity-map.mjs`.
- [Change confirmation design](../design/change-confirmation.md#approval-policy) and [requirements AC-01](../design/requirements.md#acceptance-contracts).
