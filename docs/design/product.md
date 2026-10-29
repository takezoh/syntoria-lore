# Syntoria Lore positioning, audience and messaging

This document is the source for how Lore is described to users. README and PRODUCT follow its message order, vocabulary and claim boundaries; the [product requirements](requirements.md) define the behavior and service targets those messages rely on.

## Positioning

**Explain it once. Every AI you authorize can remember it, with the reason.** (adopted 2026-10-18)

Syntoria Lore is Syntoria's Memory Service: long-term memory with evidence for the AIs a person authorizes. It keeps decisions, preferences, knowledge and experience as reusable memories, each linked to the observations behind it, who made the statement, when it applied and how it was corrected. An authorized AI can recall that memory in a later conversation, including in a different AI client, and show where it came from.

The product hypothesis is that people who work across AI assistants repeat decisions and preferences because each conversation starts without the context of earlier work, and that a shared, evidence-linked memory can reduce that repetition while making it easier to inspect who said something, when it applied and what changed. This is a positioning hypothesis, not a measured outcome.

The product name is Syntoria Lore, shortened to Lore after first mention.

### Place in Syntoria

Lore is Syntoria's Memory Service. Its subject is what has been learned and why: facts, decisions, preferences, hypotheses, experiences and procedures, with their evidence, applicability, valid time and correction history. Lore distinguishes a memory being kept, a claim being true and a decision having been made.

Syntoria Weave holds the current shared state of work—what is open, waiting or related now. Lore and Weave have separate databases, APIs, histories and change cursors. The person and their AI decide what to do in the moment and compose the services when a task needs both. Lore serves whatever authorized client holds valid access; it does not depend on Weave or on a particular assistant.

## Audience

| Segment | Role | Reason |
| --- | --- | --- |
| People who use more than one AI assistant and keep re-explaining the same background, decisions and preferences | Primary | One memory can be recalled by each authorized AI in later conversations |
| People who make lasting decisions in conversation and later need to know who said what, when and why | Primary | A decision returns with its evidence, speaker and time, distinct from an AI's suggestion |
| People who build their own agents or workflows | Secondary | REST and Remote MCP tools, idempotent writes, conflict detection and per-client change feeds |
| Complete document archiving, task or current-state tracking, reminders and calendars | Not targeted | The source system keeps originals; Weave holds current state; scheduling belongs to the person's AI environment |
| Team-wide knowledge bases shared across users | Not targeted | Memories stay within one user's account |

These segments are hypotheses, not validated market findings.

## Pillars and supporting contracts

Present the pillars in this order. Lead with continuity, explain reasons when the reader asks how Lore knows something, then correction and control.

| Pillar | Promise | Supporting contract |
| --- | --- | --- |
| Explain it once (continuity, entry) | Context told to one AI is available to another authorized AI in a later conversation | Explicit remember commits synchronously; every client that signs in with the admitted account reads the same memories through REST or MCP recall; each client can follow its own change feed |
| See why your AI knows it (reasons, differentiator) | A memory returns with what was said, by whom, where and when | Every memory revision links to at least one piece of evidence with source, locator, speaker and event time; authority is derived from the authenticated principal, memory kind and declared status, never from a request label |
| Correct it without losing what was true (correction) | A change, a mistake and a dispute are recorded differently, and past views remain available | `SUPERSEDE`, `RETRACT` and `CONTEST` semantics; valid time and recorded time; historical recall by `valid_at` and `known_at`; stale revisions are rejected |
| Decide what is kept and forgotten (control) | Sources are connected with consent, uncertain proposals wait for the person, and Forget takes effect | Consent-gated sources; capture proposals other than uncontested facts are held for review; Forget suppresses immediately and purges through the deletion ledger; encrypted export and import |

A pillar must not promise more than its supporting contract. New user-facing benefit text requires a matching row in the [Product](../../PRODUCT.md) `Value and approach` table naming the behavior that supports it; text without one is not published.

## Messaging and tone

- Headline: "Explain it once. Every AI you authorize can remember it, with the reason." Supporting line: "Your decisions, preferences and lessons stay with who said them, when they applied and what changed, so your next conversation can start from what you already explained—even in another AI you use."
- Repository description: "Give the AIs you authorize a long-term memory with evidence. Explain decisions, preferences and lessons once, and get them back later with their source and history." Lead with a verb whose subject is the reader, as Weave does. Do not use the service's own actions ("Remember", "Recall") as imperatives to the reader: the reader is the one who no longer has to remember. The Memory Service role name lives in README, PRODUCT and the repository topics.
- Because "lore" can suggest unverified folklore, introduce Lore as long-term memory with evidence before using the name alone.
- Lead with a concrete task, such as recalling why a project chose a database or which day a review moved to. Show evidence and history as the answer to "how does it know?", not as the opening.
- The person and their AI are the subjects of user-facing text. User-facing text says "AI", "memory", "source" and "reason". "Client", "principal", "grant", "binding", "observation", "Context Pack" and "ChangeSet" belong to builder and technical documentation. Access prerequisites belong in the [client access guide](../usage/sign-in.md).
- Keep limits in a "How it works" section, PRODUCT's `What Lore does not promise` list and the technical references rather than in the opening sections.
- Tone is calm, plain and honest. Avoid "never forgets", "remembers everything", "truth" or "verified" for stored claims.

## Claim boundaries

| Do not claim | Reason |
| --- | --- |
| Lore remembers everything or archives your documents | It stores submitted observations and permitted excerpts; the source system keeps the complete original |
| A returned memory is true or verified | Attribution records who made a statement; a user's confirmation records the user's statement, not an independent check |
| Lore proves that you read and meant every change you approved | Lore keeps AI writes as AI proposals and grants your authority only to an approved change. Under the default automatic policy nobody reads the change first; Lore records that the policy approved it. Approval at Gate shows that your signed-in session approved the exact change, not that you read it, and does not exclude an AI that controls your signed-in browser |
| Every AI receives updates automatically | Each client recalls again or follows its own change cursor |
| Recall finds every relevant memory | Search is bounded, indexes can lag, and an empty result is not proof of absence |
| Feedback corrects a memory | Feedback is stored and queued for reassessment; it does not revise the memory by itself |
| Forget erases backups immediately | Backups may retain content until their retention ends; a restored service must reconcile deletions before serving reads |
| Works with any AI assistant, or with ChatGPT | No hosted AI client has completed verified data operations with a real user; each client needs its own verification |
| Anyone can sign up | An operator must admit the Gate account; there is no self-service sign-up |
| Proven reduction of repeated explanation | Intended outcome, not measured |

## Benefits and evaluation criteria

| Intended benefit | Burden reduced | Evidence to seek |
| --- | --- | --- |
| Explain it once | Re-explaining background, decisions and preferences to each AI | The relevant memory is returned with useful provenance; people repeat prior context less often |
| See why your AI knows it | Searching old conversations to check who said what | Evidence attribution is complete; people can trace an answer to its source |
| Correct without losing what was true | Repeating corrections and acting on outdated context | Outdated information is rarely presented as current; a correction is visible to other clients |
| Decide what is kept and forgotten | Worrying about what AI keeps | Forget and review complete successfully; forgotten content does not reappear |

These are evaluation questions, not established results. Measurable service targets and acceptance contracts are in [product requirements](requirements.md); observed results and limitations belong in dated [evaluation records](../eval/).

## Product boundary

| Lore provides | The person and their AI determine |
| --- | --- |
| Evidence-linked memories with revisions, attribution, valid time and recorded time within one user's account | When to remember, recall, correct or forget, and what a memory means for the current task |
| Bounded recall that returns matching memories with evidence and uncertainty | How results are presented, checked and acted on |
| Consent-gated capture, curator proposals checked against cited source text, and review routing | Which sources to connect and what to send |
| Idempotent writes, revision conflict detection and a per-scope change feed | Each client's cursor, cache and retry behavior |
| Forget, retention, source rights, and encrypted export and import | Scheduling, notifications and work outside Lore |

The [memory-system reference](../technical/memory-system.md) explains what the implementation returns and its retrieval limits; [use cases](../usage/use-cases.md) show example requests.
