# Syntoria Lore — Product

**Explain it once. Every AI you authorize can remember it, with the reason.** Lore is a personal, long-term memory service for decisions, preferences, knowledge and experience. It keeps each memory beside its evidence and history, so an AI can pick up useful context in a later conversation and show where that context came from.

## Who Lore is for

Lore is for people who use more than one AI assistant, make decisions in conversation and want to know later who said what and when, or build their own authorized AI workflows. A user's memories belong to that user's account. Each connected client receives only the access allowed for it.

Lore is not a complete or authoritative document archive, task manager, reminder service or calendar. It can store text submitted as observations and evidence excerpts allowed by a source, but the source system remains the place to retrieve the complete original. An AI or person decides when to remember or recall something, how to interpret the result and what to do next.

## A memory in practice

Suppose an AI suggests a database, and you later decide to choose the technology only after the product requirements are settled. The suggestion and your decision are separate observations with different speakers. When another authorized AI asks about the project direction, Lore can return the decision with its evidence and any earlier version. If two sources disagree, Lore can keep both claims and mark the relevant memories as contested instead of silently choosing one.

The main building blocks are:

| Part | What it means |
| --- | --- |
| Memory kind | A fact, decision, preference, hypothesis, experience or procedure |
| Observation | What someone said, wrote or did in a source; it records an assertion or event, not proof that a claim is true |
| Evidence | The link from a memory revision to its source observation, location and available lineage |
| Attribution | Who made a statement, based on the authorized actor and source information |
| Time | When a memory applies and when Lore recorded or changed it |
| History | Earlier revisions, replacement and retraction reasons, and relations to other memories |

An experience keeps a condition, action and outcome together so a future AI can see when an earlier lesson may apply. Repeated copies of one summary do not become independent evidence.

## Attribution is not verification

Lore distinguishes a user's own preference or decision, an AI proposal and another person's claim. It derives authority from the authenticated actor, memory kind, epistemic status and controlled user-confirmation path; it does not take an authority label from model output. Source speaker and location help explain where a claim came from. Neither a confident summary nor the fact that a memory was useful makes an outside-world claim true.

When a user confirms a candidate, that records the user's confirmation or statement. It does not independently verify a technical or third-party claim. The [memory-system reference](docs/technical/memory-system.md) describes the current proposal and review rules.

## Time, corrections and forgetting

“It was true then, but changed later” and “that was wrong” are different corrections. A **superseded** memory records the period before its replacement. A **retracted** memory is withdrawn as wrong. A **contested** flag says that relevant information conflicts; it is not a lifecycle step. Historical recall can ask both what applied at a past time and what Lore knew at a past time.

**Forget** removes the selected content from use immediately, then a background process purges it and its dependent material. A content-free deletion record lets Lore reconcile a restored database before protected reads resume. Backups may retain deleted content until their retention period ends, so restore readiness depends on applying the deletion record first.

## Capture and recall

An explicit remember request creates a memory directly after authorization and consistency checks. For ongoing material, a connected source must first be enabled with consent and send observations to Lore; Lore does not silently fetch a user's conversations or documents. The background curator proposes memories from those observations, checks evidence anchors and existing memories, and commits only the cases allowed by policy. Proposals that require a user's judgment can be held for review.

Recall combines the question with permitted scope, source rights, memory lifecycle and time filters. It returns supported matches and their evidence, attribution and uncertainty in a Context Pack sized to the caller's requested budget. An empty result means no supported match was returned by that search; it does not prove that no relevant information exists. Search indexes and candidate limits can also affect what is found.

## Access and limits

Lore has REST and Remote MCP interfaces, but no user-facing Lore sign-in or memory browser. A hosted client needs a Gate-issued token for the exact resource, an existing identity binding and an appropriate grant; see [client access](docs/usage/sign-in.md). The repository does not provide public self-service sign-up. Lore may miss relevant information or return no supported match, so check its evidence before relying on a memory for an important decision.

Reducing repeated context and helping AIs continue useful work are intended outcomes, not a guarantee that every workflow will improve. Product requirements and acceptance targets are in [product requirements](docs/design/requirements.md). The technical reference explains the limits of capture, retrieval and Forget; dated observations belong in [evaluation records](docs/eval/).

[Use cases](docs/usage/use-cases.md) has example prompts. [Client access](docs/usage/sign-in.md) explains how a client connects. [Architecture](ARCHITECTURE.md) and the [technical memory-system reference](docs/technical/memory-system.md) cover the implementation.
