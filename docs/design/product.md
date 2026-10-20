# Product positioning

**Adopted 2026-10-18**

> Explain it once. Every AI you authorize can remember it, with the reason.

## Product hypothesis

People who work across AI assistants repeat decisions and preferences because each conversation starts without the context of earlier work. Lore's product hypothesis is that an authorized, evidence-linked memory shared across those assistants can reduce that repetition while making it easier to inspect who said something, when it applied and what changed.

This is a positioning hypothesis, not a measured outcome. The intended first audience is people who make durable decisions in conversation and use more than one AI client, followed by builders who connect their own authorized AI workflows.

## Message order

1. **Continuity:** carry useful context from one conversation and client to another.
2. **Reasons:** return memories with their supporting observations, attribution and time.
3. **Correction:** preserve what changed, what was withdrawn and what is still disputed.
4. **Control:** connect sources with consent; decide what to remember, correct or forget.

Lead with a concrete task, such as recalling why a project chose a database. Explain the evidence and history when the reader asks how Lore handles that memory. Keep setup prerequisites on the access guide and internal service behavior in the technical references.

## Claim boundary

Describe Lore as a service that stores submitted observations and evidence excerpts, not as a complete archive of source documents. Describe attribution as a record of who made a statement, not proof that the statement is true. Say that a client can request recall or read its change feed; do not imply that every AI receives updates automatically.

Search is bounded and can miss relevant information. The exact hosted client connection depends on a compatible client, its exact resource and an operator-provisioned identity binding and grant. Do not promise universal client support, self-service account creation, improved outcomes for every workflow, exhaustive recall or automatic verification of claims.

## Measures and evidence

The intended value can be assessed by whether a client returns the relevant memory with useful provenance, whether people need to repeat prior context less often, and whether users can correct or forget information successfully. These are evaluation questions, not established results. The measurable service targets and acceptance contracts are in [product requirements](requirements.md); observed results and limitations belong in dated [evaluation records](../eval/).

The user-facing explanation of memory kinds and lifecycle is in [PRODUCT](../../PRODUCT.md). [Use cases](../usage/use-cases.md) shows example requests; the [memory-system reference](../technical/memory-system.md) explains what the implementation returns and its retrieval limits.
