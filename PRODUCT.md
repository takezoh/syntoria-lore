# Syntoria Lore — Product

**Explain it once. Every AI you use remembers—and knows why.** Lore keeps what you decided, what you prefer and what you learned as long-term memory with evidence, so the AIs you authorize continue from it instead of starting from zero.

Syntoria Lore is Syntoria's Memory Service: an independent long-term memory service that turns the information it receives into reusable memories and provides them to multiple AIs together with their evidence, conditions of applicability, valid time and correction history. It handles facts, preferences, decision records, hypotheses, experiences and procedures. Explicit remembers and corrections are confirmed immediately; conversations, documents, tool results and work episodes from sources you enable are curated in the background. Every authorized AI recalls the same memories and can catch up on what changed, while you keep control over what is confirmed, corrected and forgotten. Lore is reached through REST and Remote MCP; it does not depend on a particular AI product, model or source system, and it has no app of its own for browsing memories.

## Who it is for

| Audience | Why Lore fits |
| --- | --- |
| People who work with several AI assistants and keep restating the same background | One memory serves every authorized AI, with the same meaning and evidence in each |
| People who make decisions in conversation with AI and later need to know what was decided, by whom and why | Decisions, suggestions and other people's claims stay attributed; history and evidence remain available |
| People who build their own agents or workflows | Read-only and write-capable connections are authorized separately over the same memory |

Lore is a personal service. Your memories belong to your account; several AIs and agents can work with them under the permissions you grant, without exposing them to other accounts. Task lists, reminders, calendars and the original documents themselves belong to other tools.

## Value and approach

| Desired benefit | Supporting behavior |
| --- | --- |
| Stop re-explaining yourself | Explicit remembers and corrections are committed at once and visible to the next recall from any authorized AI |
| Keep memory without upkeep | Material from enabled sources is extracted and consolidated automatically; you confirm, correct and forget, but do not file or tag |
| Know why the AI believes something | Each memory carries its source, location, speaker, when it happened and when Lore learned it |
| Never mistake a suggestion for a decision | Who said something comes from the authenticated connection and trusted source data, never from what a model claims; AI suggestions stay candidates until you confirm them |
| Tell current from past | When a memory holds and when Lore learned it are recorded separately; a replaced memory keeps its own period instead of being deleted |
| Protect current decisions from old material | Reprocessing old input cannot reverse a decision you made explicitly |
| Get only what fits | Recall packs the relevant memories into your AI's context budget without dropping their evidence or uncertainty |
| Avoid confident fabrication | Recall reports missing evidence, contradictions and possibly outdated items instead of inventing memories |
| Catch up across AIs | A change feed delivers every update, replacement and deletion since an AI last looked, without gaps |
| Forget reliably | Forgotten content is blocked at once, then deleted, and deletions are reapplied before a restored database serves anything |
| Take your memory elsewhere | Encrypted export and import reproduce memories, evidence and history in another environment |

Your AI handles interpretation, judgment and what to do next. Lore manages what is remembered, on what evidence and how: it extracts and consolidates under a fixed policy, attributes every memory, keeps history, enforces your permissions and source rights, and governs Forget, retention and portability. Its curator proposes; it does not decide what is true or what matters to your work. Reading memories gives your AI information to consider, and your AI remains responsible for understanding it.

## What Lore does not promise

- Lore does not decide what you should do, manage tasks, remind you, plan a calendar or send messages.
- Storing a memory does not make it true. Lore records who asserted what on which evidence; it does not verify external facts.
- Lore does not capture everything. It reads only the sources you enable, and it keeps uncertain or important candidates for your review.
- Extraction is a proposal under policy, not a guarantee of understanding. Extraction quality with the hosted models has not been measured.
- Lore is not an archive of your documents; originals stay where they are.
- Backups can contain forgotten content until their retention ends. Lore keeps that content from coming back by reapplying deletions before a restored database serves reads.
- Connecting AI assistants to the hosted service is not open yet. Reduced re-explanation and fewer mistakes are intended benefits, not measured results.

## Everyday usage

An AI suggests adopting a particular database. Lore records that as the AI's suggestion, observed in the conversation, not as your decision. You then say, “Choose the technology only after the requirements for the finished product are settled,” and Lore remembers that as your decision. Weeks later you revise the rule: the earlier version is kept with the period in which it held. When another AI asks for the current policy, recall returns the latest decision and, when useful, how it changed. Asked for the policy as it stood in September, recall answers from the version that held then.

A project is renamed. Lore treats the old and new names as the same subject and keeps both in order, so old documents still resolve while the current name is presented as current.

A deployment fails, and a later attempt succeeds after a configuration change. Lore keeps the condition, the action and the outcome together as one experience, so the next AI facing a similar failure can reuse what worked and see when it does not apply.

Two documents disagree. Lore keeps both claims attributed to their authors, with their subjects and times, and marks the conflict as contested instead of choosing silently. Recall shows the contradiction.

You ask to forget your old address. It stops appearing in every recall at once, AIs that catch up later learn only that a memory was removed, and the content is then deleted.

## Memories and their meaning

| Concept | Meaning |
| --- | --- |
| Source | Where input comes from—a conversation, document, tool result, work episode or an explicit remember—with the rights and consent you gave |
| Observation | What was said, written or happened in a source: that someone asserted something, not that it is true |
| Evidence | The link from a memory to the observations behind it; every revision keeps its own evidence |
| Memory | A reusable statement interpreted from observations, kept apart from whether the underlying claim is true |
| Kind | Fact, preference, decision, hypothesis, experience or procedure |
| Experience | A condition, an action and an outcome kept together rather than split into isolated sentences |
| Subject | A stable person, project or thing, including names it had at different times |
| Authority | Whose word counts depends on the subject: you decide your own preferences and policies, other people's claims stay theirs, and measured results show how something actually behaves. No single trust score replaces it |
| Context Pack | A recall result sized for your AI, with evidence, contradictions, unknowns, freshness and coverage |

## Lifecycle and time

A memory is a **candidate** until it is confirmed, then **active**. Later it can be **superseded** (it held in its time and has been replaced), **retracted** (it was wrong) or **forgotten** (its content must no longer be used and is deleted). **Contested** is a separate flag: a contradiction is a state of knowledge, not a sign that a memory is out of date.

Every memory records when it holds and when Lore learned it. Unknown times stay unknown rather than guessed. Recall can therefore answer what holds now, what held at a given time, and what Lore knew at a given time.

An AI's suggestion never overwrites your decision. Your own technical claim is remembered as your claim, not as a verified fact. Merging duplicates never erases independent evidence, time or applicability.

## Capture, recall and reliability

| When | What happens |
| --- | --- |
| You ask to remember or correct something | Committed after permission and consistency checks; the next recall sees it |
| An enabled source sends a conversation or work record | Selective extraction and consolidation; committed or held for review by policy |
| A source changes or loses its rights | Dependent memories are blocked immediately where required, then re-evaluated |
| Time passes | Bounded maintenance applies retention, retries failed work and repairs search indexes |
| An AI reports how a memory worked out | The report is queued for reassessment; being used never makes a memory true |
| You forget something or withdraw an AI's permission | Unusable at once; deletion is tracked to completion |

Automation is the default and your review the exception. Uncertain information stays a candidate or is marked contested rather than committed.

Changes never silently overwrite each other: a write based on an outdated revision is rejected, a repeated request is applied once, and a lost response can be checked or resent safely. Each AI can follow a change feed from its own position; deletions appear there only as notices without content. Permissions are checked on every request and inside the database itself, so one AI's access does not reveal memories outside what you granted it.

## Scope and evidence

The current implementation covers explicit remember and correction, consented capture with curation and user review, recall in precise, contextual, historical, exploratory and changes modes, the change feed, Forget and source-rights revocation, retention, encrypted export and import, and separate read-only and write-capable MCP connections. Local acceptance with a real PostgreSQL database, a 231-case deterministic evaluation, two MCP clients and recovery smoke tests is recorded in [local acceptance](docs/eval/local-acceptance.md). Its providers are deterministic fixtures, so it does not establish extraction quality, cloud behavior or scale.

The service is deployed on Google Cloud with Neon PostgreSQL and runs privately. Hosted checks have passed for authorized recall over REST and MCP, background job delivery, and an encrypted export, import, recall and Forget run between two accounts. Opening connections to AI assistants, the user's own sign-in setup, point-in-time database recovery, load, latency and cost targets, alerting and production acceptance remain open; the [cloud verification register](docs/eval/cloud-verification.md) is the current record. The measurable product contract is in the [product requirements](docs/design/requirements.md).

Success means less context to re-explain, fewer factual and policy mix-ups and better results from the AIs that use the memory. More stored memories alone are not success, and forgetting can be the right choice. General availability and pricing remain undecided.

[Introduction](README.md) · [Architecture](ARCHITECTURE.md) · [Development](docs/development.md)
