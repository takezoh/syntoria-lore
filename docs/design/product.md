# Syntoria Lore positioning, audience and claim boundaries

This document is the product design reference for everyone who writes about Lore: README, PRODUCT, usage guides, tool descriptions and listings. It fixes the positioning, the audience, the promises Lore may make and the claims it must not make. The measurable product contract is in [requirements](requirements.md).

## Positioning

**Explain it once. Every AI you use remembers—and knows why.**

Syntoria Lore is Syntoria's Memory Service: an independent long-term memory service that turns the information it receives into reusable memories and provides them to multiple AIs together with their evidence, conditions of applicability, valid time and correction history. It handles facts, preferences, decision records, hypotheses, experiences and procedures.

Lore manages what is remembered, on what evidence, and how. It keeps past decisions and the user's preferences available to the next conversation, updates memories when information is corrected, and returns what a task needs as a Context Pack with evidence, contradictions, unknowns, freshness and retrieval coverage. It keeps apart three different things: that something was adopted as a memory, that its content is true, and that it is a business decision. An AI's suggestion is never saved as the user's decision.

The intended outcome is less context to re-explain, fewer factual and policy mix-ups, and better task results for the AIs that use the memory. The number of stored memories is not an outcome.

The product name is Syntoria Lore, shortened to Lore after first mention. Source code, package names, database roles and OAuth scopes use generic `memory` identifiers; the name appears in documentation, host listings and the configured `PRODUCT_DISPLAY_NAME`. Thymesis is the former name and remains in dated records and some deployed resource names.

## Place in Syntoria

Syntoria is a family of independent AI services for memory, shared state, meeting and activity records, and PC access and execution. The name combines synthesis and historia: the history of memory, conversation, judgment and action, put to use in the next piece of intellectual work. Each service stands alone. Belonging to the series implies no required processing order, mutual dependency, shared database or integrated deployment.

```text
Syntoria Lore  (memory)    ─┐
Syntoria Weave (state)     ─┼─ Personal AI (judgment and composition)
Syntoria Trace (record)    ─┤
Syntoria Reach (execution) ─┘
```

| Service | Responsibility | Concept |
| --- | --- | --- |
| Lore | Accumulates experience, knowledge and context as long-term memory with evidence, applicability, valid time and correction history; supports recall and correction | Memory |
| Weave | Shares the current state of people and AI—actions, pending decisions, intent and relations—and stores, reads and updates it | State |
| Trace | Records and structures meetings and activities so that claims lead back to the utterance or screen behind them | Record |
| Reach | Accesses PCs and runs work delegated to a PC or the cloud, including checkpoints, stopping, retries and returning results | Execution |

The Personal AI is not a Syntoria product. It understands the user's intent, combines the services as needed, and together with the user decides what to do now and how to interpret results.

Lore does not own current shared state (Weave) or the decision and action for the task at hand (the Personal AI). Lore and Weave have separate databases, APIs, histories and change cursors; a procedure that needs both is composed by the caller. Lore does not copy Weave's actions or task progress. A memory that needs a Weave event as evidence references its URI or ID.

### What the name must be explained with

The names in the family symbolize capabilities rather than describe functions. Lore means accumulated knowledge: memory built up together with its evidence and applied to the next decision. Because lore can also suggest tradition of uncertain origin, every introduction states first that Lore is **long-term memory with evidence**. When Reach or another service records its own execution history, call it an execution log or run history, not a trace or a memory.

## Audience

| Segment | Role | Reason |
| --- | --- | --- |
| People who use several AI assistants and keep restating the same background | Primary | They gain most from one memory that every authorized AI reads with the same meaning and evidence |
| People who make decisions in conversation with AI and later need to know what was decided, by whom and why | Primary | Attribution, valid time and correction history are what make a remembered decision usable |
| People who build their own agents or workflows | Secondary | Separately authorized read-only and write-capable REST and MCP entry points over one contract |
| Teams that need organization-wide knowledge management, document archives or a general knowledge graph | Not targeted | Lore is a personal service with one user; originals stay in their source systems |

These segments are hypotheses, not validated market findings.

## Pillars and supporting contracts

| Pillar | Promise | Supporting contract |
| --- | --- | --- |
| Stop re-explaining yourself (entry) | Say a decision, preference or correction once; the next conversation and the next AI already know it | Synchronous commit for explicit remember and correction; read-after-write recall from the source of truth; one memory across authorized clients |
| See where every memory came from (core) | Any memory can be traced back to who said it, where and when | Evidence locators per revision; attribution derived from authenticated identity and trusted source metadata; independent-evidence lineage |
| Your decisions stay yours (primary differentiator) | An AI's suggestion never turns into your decision | Authority is never taken from model output; AI and client proposals stay candidates until the user confirms them; a client cannot rewrite an user-attributed memory |
| Corrections stick (differentiator) | Changing your mind does not erase history, and old material cannot bring an old policy back | Supersede with valid-time intervals; separate recorded time; reprocessing cannot reverse an explicit user decision |
| Gaps are named, not filled | Recall says what it does not know | Explicit unknown results, contested flags and coverage in every Context Pack |
| Forget means forget (reason to believe) | Forgotten content is gone from every path and does not come back | Immediate suppression, physical purge, deletion ledger reapplied before a restored database serves reads |

Lead with relief from re-explaining, then the safety of attribution and correction. Use Forget and restore guarantees as reasons to believe. A pillar must not promise more than its supporting contract. New user-facing benefit text requires a matching row in the [PRODUCT](../../PRODUCT.md) `Value and approach` table naming the behavior that supports it; text without one is not published.

## Messaging and tone

- Headline: "Explain it once. Every AI you use remembers—and knows why." Supporting line: "Long-term memory with evidence for your AIs. What you decided, what you prefer and what you learned are kept with their source, the time they hold and every correction, so a new conversation does not start from zero."
- Repository description: "Long-term memory with evidence for the AIs you use. Remember decisions, preferences and lessons once, with their source and history, and recall them from any authorized AI."
- The headline, supporting line and repository description were adopted by the user on 2026-10-18.
- Introduce Lore as long-term memory with evidence before anything else.
- Write benefit- and scene-first. The user and their AI are the subjects of user-facing text. Show the value through a decision recalled by a different AI, a correction that sticks and an honest unknown.
- User-facing text says "AI", "remember", "recall", "correct" and "forget". "LLM", "caller", "principal", "scope" and "ChangeSet" belong to technical and API documentation. The user is "you" in user-facing text.
- Tone is calm, plain and honest. Avoid "AI that never forgets" or "perfect memory" hype; remembering less and forgetting deliberately are legitimate outcomes.

## Claim boundaries

| Do not claim | Reason |
| --- | --- |
| Lore knows what is true | It records who asserted what on which evidence; it does not verify external facts |
| Lore decides what you should do | The Personal AI and the user decide; Lore returns memories and their uncertainty |
| Lore remembers everything automatically | Capture is limited to sources the user enabled; uncertain candidates are held |
| Extraction is accurate | Curator output is a policy-checked proposal; hosted extraction quality has not been measured |
| Forgotten content disappears from every backup at once | Backups keep content until their retention ends; Lore reapplies deletions before serving a restored database |
| Works with any AI assistant today | Hosted API and MCP endpoints are private; no client integration has hosted acceptance yet |
| Faster, cheaper or more accurate than other memory products | No comparative measurement exists; the local evaluation uses deterministic fixtures |
| Proven reduction of re-explanation or mistakes | Intended outcome, not measured |

## Benefits and evaluation criteria

| Intended benefit | Burden reduced | Evidence to seek |
| --- | --- | --- |
| Stop re-explaining | Restating background, decisions and preferences in every conversation | Less context the user supplies for representative tasks, without loss of task success |
| Trust what the AI recalls | Checking whether a recalled statement is real, current and whose it is | Every recalled memory carries attribution and evidence; false-current rate stays low |
| Keep decisions intact | Correcting an AI that treated a suggestion or an old policy as current | Zero AI proposals stored as user decisions; old sources do not override current decisions |
| Continue across AIs | Repeating corrections to each assistant | A correction made through one client is recalled by another |
| Forget with confidence | Worrying that deleted information resurfaces | No forgotten content in recall, export or change feed, including after restore |

These are intended outcomes, not measured long-term effects. Evaluate with a no-memory baseline and a simple-summary baseline on representative tasks, counting the context the user had to supply, corrections and task success.

## Product boundary

| Lore provides | The user and their AI determine |
| --- | --- |
| Durable memories with evidence, attribution, valid time and revision history within one user | Which conversations and sources to share, and what is worth remembering |
| Capture, curation under policy, user review, recall and change feed through REST and MCP | When to remember, recall or catch up, and how to interpret the result |
| Explicit correction, retraction and Forget with immediate effect | What is true, what matters and what to do next |
| Encrypted export and import | Where the memory goes and who receives it |

Lore owns its curator as part of memory management: extraction and consolidation are proposals under policy, never decisions about the user's work. Do not add task management, reminders, calendar planning or an assistant that acts on memories; those belong to the caller or to another Syntoria service.
