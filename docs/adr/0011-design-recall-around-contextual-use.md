---
id: adr-0011-design-recall-around-contextual-use
kind: adr
title: Evaluate recall by contextual use of accumulated memory
status: proposed
created: '2026-11-12'
decision_makers:
- owner
relations:
- {type: references, target: adr-0010-record-observations-and-derive-the-current-state}
summary: Retain the observation ledger and Firestore while making contextual retrieval and client use explicit acceptance contracts.
---

# Evaluate recall by contextual use of accumulated memory

## Decision

Following the owner's request on 2026-11-12 to take over the stopped work, define the outcome, revise the design and create evaluation data, propose the [situational recall contract](../design/situational-recall.md). Keep Firestore and the observation ledger. Design for relevant evidence being used in a new situation without repeated explanation, rather than treating storage or an exact-name hit as success.

This is a proposed implementation decision; document and fixture delivery does not approve a release or demonstrate effectiveness.

## Requirements and rationale

The owner identified situational recall and semantic retrieval as central. Code inspection shows fixed ten-vector candidate retrieval, post-retrieval eligibility filtering, lexical/name precedence, and a cap on semantic-only results when lexical hits exist. These are plausible recall bottlenecks, not measured quality failures. Current topic projection can also omit the historical observation that caused a match.

| Alternative | Decision basis |
| --- | --- |
| Keep storage and improve retrieval, evidence presentation and client behavior | Selected; directly addresses the identified mechanisms without moving persistence |
| Replace Firestore first | No measurement establishes that a storage migration is needed |
| Rely only on shared files and keyword search | Useful evaluation baseline; does not establish contextual recall at growing volume |
| Require a model reranker immediately | Deferred until it beats a deterministic fusion baseline on quality and cost |

## Consequences

Add intent, candidate budgets, eligibility recovery, matched-evidence responses and independent index recovery in the domain layer. Adapters expose the contract; clients decide when to call and how to use evidence. Model and ranking changes require versioned evaluation.

No identity or stored observation rewrite is authorized by this decision. Keep rights, source references, Forget and restore reconciliation. Additional index partitions, if selected, must obey the same deletion rules. Operational cost and response latency must be measured; limited returned documents do not establish constant vector-search work.

## Confirmation

Use the [synthetic protocol](../eval/fixtures/situational-recall.md), then held-out realistic questions and fresh client sessions. Require all prohibited-content and stale-as-current guardrails to pass. Report retrieval recall, irrelevant inclusions, evidence attribution, answer use, latency and cost separately. Dataset integrity is not a search-quality result. No retrieval or client-use run has been performed for this decision.

## Sources

- Owner direction of 2026-11-12: take over the stopped Claude session, define the outcome, revise the design and create evaluation data.
- [Observation ledger design](../design/observation-ledger.md)
- [Situational recall contract](../design/situational-recall.md)
- [Recall implementation](../../packages/memory-records/src/observation-service.ts)
- [Vector candidate implementation](../../packages/memory-records/src/firestore-observation-ledger.ts)
