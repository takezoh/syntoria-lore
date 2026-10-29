# Syntoria Lore — Product

**Explain it once. Every AI you authorize can remember it, with the reason.** Your decisions, preferences and lessons stay with who said them, when they applied and what changed, so your next conversation can start from what you already explained—even in another AI you use.

Syntoria Lore is Syntoria's Memory Service: long-term memory with evidence for the AIs you authorize. It turns what you and your AIs submit into reusable memories—facts, decisions, preferences, hypotheses, experiences and procedures—each linked to the observations behind it, who made the statement, when it applies and how it was corrected. AI clients that sign in with your account read and update the same memories through REST and Remote MCP, so context explained in one conversation can be recalled in another and checked against its source. The intended benefit is less re-explaining and fewer mistakes from outdated or misattributed context. Lore does not depend on a particular assistant.

## Who it is for

| Audience | Why Lore fits |
| --- | --- |
| People who use more than one AI assistant and keep re-explaining the same background | A memory saved through one AI can be recalled by another authorized AI in a later conversation |
| People who make lasting decisions in conversation | A decision returns with its evidence, speaker and time, distinct from an AI's suggestion and from what has since changed |
| People who build their own agents or workflows | REST and Remote MCP tools with idempotent writes, conflict detection and a change feed for each client |

A user's memories stay within that user's account. Lore is not a complete or authoritative document archive, a task or current-state tracker (that is Syntoria Weave), a reminder service or a calendar. You and your AI decide when to remember or recall something, how to interpret the result and what to do next.

## Value and approach

| Desired benefit | Supporting behavior |
| --- | --- |
| Explain it once | An explicit remember commits synchronously; every AI client that signs in with your account can recall it later |
| Pick up context in another AI | Recall returns matching memories within the caller's size budget; each client can follow its own change feed to catch up |
| See why your AI knows it | Every memory revision links to at least one piece of evidence with its source, location, speaker and event time |
| Tell your decision from an AI's suggestion | Authority is derived from the signed-in account, the memory kind and the status the write declares; a write marked as proposed keeps AI-proposal authority and waits as a candidate; a request cannot set authority directly |
| Correct it without losing what was true | Supersede keeps the earlier period, retract records a mistake and contest flags a dispute; a write based on an outdated revision is rejected instead of overwriting newer work |
| Ask what was true then | Historical recall can ask what applied at a past time and what Lore knew at a past time |
| Reuse a lesson where it applies | An experience keeps the condition, action and outcome together |
| Capture without retyping | Sources are enabled with consent; curator proposals are checked against the cited source text; only uncontested facts are saved automatically and the rest wait for review |
| Forget | Forgotten content stops being returned immediately, a content-free deletion record is kept, and a background process purges the content and its dependent data |
| Take your memories with you | Memories, evidence and history can be exported as an encrypted bundle and imported elsewhere, with the original attribution kept as provenance |

## What Lore does not promise

- Lore does not verify that a memory is true. Attribution records who made a statement.
- Lore cannot tell whether a statement saved under your account came from you. It admits your Gate account rather than each AI client and records the status your AI declares, so an AI connected as you must save its own suggestions as proposals.
- Recall is bounded and can miss relevant memories. An empty result does not prove that nothing was said.
- AIs do not receive memory changes automatically; each one recalls again or follows its own change feed.
- Lore is not a complete archive of source documents. It keeps submitted observations and the excerpts a source permits.
- Lore does not fetch your conversations or documents on its own.
- Feedback such as “incorrect” queues a reassessment; it does not change a memory by itself.
- Backups may retain forgotten content until their retention period ends.
- There is no self-service sign-up, and end-to-end use with a hosted AI client has not been verified.
- Less repeated explanation is an intended benefit, not a measured result.

## A memory in practice

Suppose an AI suggests a database, and you later decide to choose the technology only after the product requirements are settled. The suggestion and your decision are separate observations with different speakers. When another authorized AI asks about the project direction, Lore can return the decision with its evidence and any earlier version. If two sources disagree, Lore can keep both claims and a contested flag can mark the dispute instead of silently choosing one; a captured proposal that conflicts with an existing memory waits for your review.

The main building blocks are:

| Part | What it means |
| --- | --- |
| Memory kind | A fact, decision, preference, hypothesis, experience or procedure |
| Observation | What someone said, wrote or did in a source; it records an assertion or event, not proof that a claim is true |
| Evidence | The link from a memory revision to its source observation, location and available lineage |
| Attribution | Who made a statement, based on the signed-in account, the declared status and source information |
| Time | When a memory applies and when Lore recorded or changed it |
| History | Earlier revisions, replacement and retraction reasons, and relations to other memories |

An experience keeps a condition, action and outcome together so a future AI can see when an earlier lesson may apply. Repeated copies of one summary do not become independent evidence.

## Attribution is not verification

Lore distinguishes a user's own decision or preference, an AI proposal and a claim attributed to someone else. It derives authority from the signed-in account, the memory kind, the declared epistemic status and the controlled user-confirmation path; it never takes an authority label from a request or from model output. Because Lore admits a Gate account rather than an individual client, an AI connected as you writes as you: what it saves as asserted is recorded as your statement, and what it marks as proposed stays an AI proposal until you confirm it. Source speaker and location help explain where a claim came from. Neither a confident summary nor the fact that a memory was useful makes an outside-world claim true.

When a user confirms a candidate, that records the user's confirmation or statement. It does not independently verify a technical or third-party claim. The [memory-system reference](docs/technical/memory-system.md) describes the current proposal and review rules.

## Time, corrections and forgetting

“It was true then, but changed later” and “that was wrong” are different corrections. A **superseded** memory records the period before its replacement. A **retracted** memory is withdrawn as wrong. A **contested** flag says that relevant information conflicts; it is not a lifecycle step. Historical recall can ask both what applied at a past time and what Lore knew at a past time.

**Forget** removes the selected content from use immediately, then a background process purges it and its dependent material. A content-free deletion record lets Lore reconcile a restored database before protected reads resume. Backups may retain deleted content until their retention period ends, so restore readiness depends on applying the deletion record first.

## Capture and recall

An explicit remember request creates a memory directly after authorization and consistency checks. For ongoing material, a connected source must first be enabled with consent and send observations to Lore; Lore does not silently fetch a user's conversations or documents. The background curator proposes memories from those observations, checks evidence anchors and existing memories, and commits only the cases allowed by policy. Proposals that require a user's judgment are held for review.

Recall combines the question with permitted scope, source rights, memory lifecycle and time filters. It returns supported matches with their evidence, attribution and uncertainty in a bounded selection sized to the caller's budget. An empty result means no supported match was returned by that search; it does not prove that no relevant information exists. Search indexes and candidate limits can also affect what is found, so check the evidence before relying on a memory for an important decision.

## Access

AI clients connect through REST and Remote MCP; Lore has no sign-in page or memory browser of its own. Gate handles sign-in and approval, and the service operator must admit your Gate account to Lore before a client can read or write memories. Every client you approve with that account acts as you; to keep one read-only, connect it only to the read endpoint. See [client access](docs/usage/sign-in.md).

## Scope and evidence

Product requirements and acceptance targets are in [product requirements](docs/design/requirements.md); positioning and claim boundaries are in [product design](docs/design/product.md). Local tests and implementation completion do not establish hosted acceptance or a reduction in repeated explanation. Dated observations and their limits belong in [evaluation records](docs/eval/).

[Introduction](README.md) · [Use cases](docs/usage/use-cases.md) · [Client access](docs/usage/sign-in.md) · [Architecture](ARCHITECTURE.md) · [Memory system](docs/technical/memory-system.md)
