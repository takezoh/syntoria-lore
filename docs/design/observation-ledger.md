# Observation ledger design

This document turns [ADR 0010](../adr/0010-record-observations-and-derive-the-current-state.md) into contracts. It is for the people who implement and review the replacement of Memory Records. It was written on 2026-11-12, and units 1 to 7 below were implemented and verified on the emulator the same day; the [architecture](../../ARCHITECTURE.md) describes the code, and dated [evaluation records](../eval/) say what was observed on the hosted service.

## Outcome

AIs that observe a person's work write what matters to Lore as it happens. Later, any authorized AI asks about a person, customer, project or decision and gets the present state, how it came to be, who observed it and where the original is, without a person having reviewed anything and without Lore holding a copy of the original.

## Conditions

These come from the owner and are not open in this design.

| Condition | Consequence for the design |
| --- | --- |
| Other AIs observe; Lore is only written to | Lore never fetches a source. Everything it knows about a source is what a writer or reader reported |
| Writes are many and keep growing | No read may scan a collection. Every read is by key or a bounded index query |
| No person reviews individual memories | No state waits for approval. Trust is derived from provenance, and conflicts stay visible |
| Things change | Nothing is rewritten. Earlier states stay, the present is marked, and the change is a record |
| Originals are not copied | An observation holds a summary and references. No field holds a message or document body |

## Terms

| Term | Meaning |
| --- | --- |
| Observation | One write by one AI: a summary, its subjects, an aspect, times, provenance and source references. Immutable |
| Subject | A person, organization, project, product or other thing observations are about. Has a stable ID and names |
| Alias | A normalized name that points to one or more subjects |
| Aspect | What about the subject an observation states, as a short label such as `quoted price` |
| Topic | One aspect of one subject. The observations of a topic, in time order, are its course |
| Nature | `state`: holds until something else does. `event`: happened at a time and is not replaced by a later one |
| Relation | An appended, revocable record saying how one observation relates to another |
| Topic view | The derived present of a topic: latest state, the one before, when it changed, agreement and conflicts |
| Tier | How an observation came to be: `person`, `source` or `inference` |

## Observation

### Fields

| Group | Field | Set by | Contract |
| --- | --- | --- | --- |
| Identity | `id` | server | Derived from tenant, scope, writer connection and idempotency key, so a resend is the same document |
| | `tenantId`, `scopeId`, `schemaVersion` | server | From the verified actor |
| Content | `summary` | writer | The important points in the writer's own words, at most 2,000 characters. Not a transcript or excerpt |
| | `title` | writer | A short name, at most 120 characters |
| | `nature` | writer | `state` or `event` |
| | `kind` | writer | Optional label: `decision`, `fact`, `preference`, `plan`, `lesson`, `procedure` |
| | `value` | writer | For a state, the state itself in a few words, such as an amount, a status or a name. Optional |
| Subject | `subjects` | writer, resolved by server | One to ten names or subject IDs. The first is the primary subject. Stored as subject IDs together with the names as written |
| | `aspect` | writer | Required for a state, optional for an event. Normalized for the topic key |
| Time | `recordedAt` | server | When Lore received it |
| | `observedAt` | writer | When the writer learned it; defaults to `recordedAt` |
| | `effectiveAt` | writer | When the state began or the event happened; null when unknown |
| | `effectiveUntil` | writer | When a state is known to have ended; normally absent |
| Provenance | `writer` | server | Principal and connection of the authenticated writer |
| | `tier` | server | See [Trust](#trust) |
| | `speaker` | writer | Who said or decided it, as text; not an identity |
| Sources | `sources` | writer | Zero to ten references; see [Source references](#source-references) |
| Disclosure | `compartmentIds` | writer, checked by server | Within the writer's allowance; joined into every derived document |
| Correction | `retracts` | writer | ID of an observation this one declares mistaken; see [Relations](#relations) |

Unknown times stay null. Lore does not guess a time, a subject or an aspect.

### State and event

A state is something that holds for a while: an amount quoted, where a deal stands, who is responsible, what was decided. An event is something that happened: a visit, a call, a message sent. A later state changes what is current; a later event does not make an earlier one less true. Only states take part in the current state of a topic. Events of a subject are read as a timeline.

A decision is a state of the question it answers. A plan is a state until it is carried out or changed.

### What an observation is not

It is not revised. A sharper wording, a correction or a new state is a new observation. It is not a document: a meeting that produced three decisions is three observations that cite the same source.

## Subjects and aliases

A writer names subjects in its own words. Lore normalizes each name (NFKC, lower case, trimmed) and looks it up in the alias table.

| Lookup result | What Lore does |
| --- | --- |
| One subject | Uses it |
| No subject | Creates a subject with this name |
| Several subjects | Uses none of them; records the name as ambiguous on the observation and creates no subject |

A writer may pass other spellings of a subject; each becomes an alias of it. A writer may state that two subjects are the same. That is a `same-as` link, appended and revocable. Lore never merges two subjects into one document, because a wrong merge cannot be undone. Reads follow `same-as` links when they collect topics.

Lore does not decide on its own that two names mean the same subject. A different spelling that no writer linked stays a separate subject until one does.

## Topics and the course of a change

The topic key is the primary subject's ID with the normalized aspect. All state observations with one key form one course, ordered by `effectiveAt` and, where that is null or equal, by `recordedAt`.

### Relations

Writing a state observation into a topic that already has a current state appends one relation from the new observation to that state.

| Relation | When | Effect on the view |
| --- | --- | --- |
| `restates` | Both have a `value` and the normalized values are equal | Current state unchanged; the new writer counts as agreeing |
| `follows` | The new one is later and the values differ, or a value is missing | The new one becomes current; the earlier one becomes the previous state. `changed` is `yes` when both values exist and differ, otherwise `unknown` |
| `precedes` | The new one is earlier than the current state | Inserted into the course; current state unchanged |
| `conflicts` | The new one is later, the values differ, and its tier is lower than the current state's | Current state unchanged; the conflict is open |
| `retracts` | The writer set `retracts` | The retracted observation leaves the course; the view is recomputed from what remains |

The first four relations follow from the course by rule, so they are recomputed whenever the course changes, for example when an earlier observation arrives late; the relation stored with an observation is the one that held when it was written. `retracts`, like the links between subjects and between topics, is declared by a writer: it is appended, never edited, and revoked only by appending a revocation. An open conflict closes when an observation of the current state's tier or higher follows either side, or when one side is retracted.

`retracts` takes effect only from the writer of the retracted observation or from a tier at least as high as its tier, so retracting a `person` observation needs the person's authority. Any other retraction is stored and has no effect. A retraction that was itself retracted has no effect either.

A state whose `effectiveAt` is later than the time of the read is announced, not current. It is listed as upcoming and joins the course when its time arrives, so a date far in the future cannot hold the present state against later reports.

Lore does not use a model to decide a relation. Where the rule cannot tell whether a state changed, the view says `unknown` and returns both summaries.

### Topic view

One document per topic, written in the same transaction as the observation.

| Field | Meaning |
| --- | --- |
| `current` | ID, value, summary, effective time, tier and writer of the current state |
| `previous` | The same for the state before it, or null |
| `changedAt`, `changed` | When the current state took over, and `yes`, `no` or `unknown` |
| `agreeing` | Number of distinct writers whose observations restate the current state |
| `conflicts` | IDs of observations in open conflict with the current state |
| `count`, `firstAt`, `lastRecordedAt` | Size and span of the course |

The view is a cache. A rebuild from observations and relations must give the same document.

### Topics that should be one

Two writers may name the same matter with different aspects. Lore links topics; it does not merge them. A writer or reader may state that two topics of one subject are the same, as an appended, revocable link, and reads then present them as one course. How often this happens is one of the measurements in [Evaluation](#evaluation).

## Trust

| Tier | Assigned when |
| --- | --- |
| `person` | The write asks for the person's authority and the approval policy grants it, as today |
| `source` | The observation cites at least one source reference outside Lore |
| `inference` | Otherwise |

The server derives the tier. A request field cannot set it. A source reference raises the tier only because it lets a reader go and check; it is not a claim that the summary is faithful.

Nothing is withheld for lack of approval. Every result carries the tier, the writer, the sources with the time they were read, the number of agreeing writers and any open conflict, and the reader judges with those.

A writer connection or a period can be suppressed as a whole: its observations leave every view and index until the suppression is lifted. This is the answer to a writer that was misled or injected.

## Source references

A reference identifies the original by the provider's own identifiers first and a link second.

| Provider | Identifiers |
| --- | --- |
| Slack | workspace ID, channel ID, message timestamp, thread timestamp |
| Gmail | RFC 822 Message-ID, thread ID, the mailbox the writer read it in |
| Notion | page ID, block ID |
| Google Drive | file ID, revision or version as seen |
| Other | provider name and an opaque resource ID |

Each reference also holds: a link for people, the title, the version or last-edited value the writer saw, `readAt`, a locator inside the original as a label (a heading, a page), and a sensitivity marker. It holds no quotation and no body.

Lore never fetches a source, so it cannot say that a source is unchanged. A reader that opens the original may report what it found: unchanged, changed, gone or no access, with the time. Lore appends that report to the reference's history and returns the latest with each result.

Whether a provider's terms allow keeping a summary of content read through its API is a legal question this design does not settle. The Slack API terms in particular need a reading before Slack-derived observations are kept for long.

## Reading

### Questions the interface answers

| Question | Path |
| --- | --- |
| What is the state of X? | Names in the query resolve through the alias table to subjects; their topic views are read by key |
| What happened with X, in order? | Events and state changes of the subject, by subject and time index |
| What was it before? When did it change? | The topic's course and relations |
| What held on a given date? | The course cut at that date, from everything known now, so a state reported later about an earlier date is part of the answer |
| Find something by a term or by meaning | Bounded index queries, then the topics and observations they point to |

### Recall

1. Find names. Each run of the query and each adjacent pair of runs is looked up in the alias table. These are direct reads.
2. Read the topic views of the subjects found, most recently changed first, up to a limit.
3. Query the term index for at most thirty terms of the query, preferring terms that are not Japanese bigrams, then bigrams of the longest runs. Results are bounded and ranked in Lore with the term weighting of [ADR 0009](../adr/0009-keep-firestore-and-repair-in-process-term-matching.md).
4. Query the vector index with the scope and disclosure filters, bounded.
5. Merge. Subjects found by name come first. Each result is a topic with its view, or an event, and says how it was found.
6. Re-read every observation returned and recheck allowance, source rights and suppression before it leaves.

The response for a topic gives the current state, a line for the change (when, from what, on whose observation), the agreeing count, open conflicts and the sources. A request may ask for the full course instead.

No step reads a collection in full, and the number of documents read has an upper bound that does not depend on the size of the memory.

### Limits

Term search finds names and distinctive terms. A query of only common words returns part of what matches, and the response says so. A subject that no writer named or linked under the spelling in the query is found only by term or vector search.

## Writing

One transaction: resolve subjects, create missing subjects and aliases, write the observation, read the topic view and the current state, append the relation, write the view, append the change-feed entry and the index job. No model call and no source fetch happens inside it. A resend with the same idempotency key returns the first result.

Two AIs reporting the same event are two observations. For a state they meet in one topic and agree. For an event Lore keeps both; it does not judge that two event summaries describe the same thing.

A written observation is found at once by ID, subject and topic. Term and vector search follow when its index job has run, and the response reports the lag as today.

## Forget

Forget takes an observation, a subject or a source reference. For a subject it covers every observation whose primary subject it is; for a source reference, every observation that cites it. It records the request, suppresses the content, appends to the independent deletion ledger and reports use stopped only when that append is durable, as today. Purge removes the observations, their index entries and their text in views, and rebuilds the views of the topics touched. Relations that pointed at a forgotten observation keep IDs and times and no content.

## What Firestore Standard does not provide and Lore builds

| Need | Built as | Stated limit |
| --- | --- | --- |
| Join of observation, relation, subject and view | Denormalized views written in the write transaction, and bounded reads assembled in code | A view must be rebuildable; a rebuild tool is part of the work |
| Aggregates | Counters in the view, updated in the write transaction | Exact per topic; no ad hoc aggregate across topics |
| Japanese and mixed-script term search | Bigram and word terms per observation, queried with at most thirty terms, ranked in Lore | Not full-text search; partial for queries of common words |
| Ranking | In Lore, over bounded candidates | Quality is measured, not assumed |
| Vector search | `findNearest` with equality filters | At most 1,000 results per query; a flat index, so every query is filtered |
| A second line of defence for access | None exists | The repository boundary and its tests are the only protection, as today |

Composite and vector indexes are declared with the code and created on the managed service before the release that needs them. The emulator does not enforce indexes, so each query is also run on the managed service before it is relied on.

## Migration

The existing records are converted, not reinterpreted.

- Each record's latest revision becomes one `event` observation with its statement as summary, its title, subjects, sources, writer, times and compartments. Its kind is kept as the label. No aspect or value is invented, so converted observations join no topic.
- Records with user authority become `person` tier; the others take `source` or `inference` by the rule above.
- Earlier revisions are kept in the old collections, which stay read-only.
- The MCP tools are replaced in one release: `observe`, `recall`, `get_timeline`, `get_observation`, `link`, `report_source`, `forget`, `get_changes`, `get_access`. The old write tools are removed; clients fetch the new list and instructions.

## Units

Each unit is verified on the emulator. Where the implementation settled a detail differently from the sections above, the notes under the table say so.

| Unit | Scope | Distinguishing check |
| --- | --- | --- |
| 1 Value model | Observation, relation and view types; validation; the relation rule and view computation as pure functions | A sequence of observations with out-of-order times, missing values, mixed tiers and a retraction gives the expected relations and view, and recomputing from scratch gives the same view |
| 2 Write path | The write transaction, subjects and aliases, idempotency, change feed | A resend changes nothing; an ambiguous name creates no subject; two writers restating a state raise the agreeing count; a lower tier opens a conflict instead of taking over |
| 3 Read by key | Topic views, courses, timelines, a course cut at a date, `same-as` and topic links | Every read touches a bounded number of documents with a large memory present; the state before a change and on a past date is returned |
| 4 Search | Term and vector index entries, recall assembly, rechecks before return | A name written in another script is found through its alias; a query of common words reports partial results; a suppressed writer's observations leave results |
| 5 Service | MCP tools and instructions, access, source reports | The tools drive the units above through a real MCP client; tier and writer cannot be set by a request |
| 6 Forget | Forget by observation, subject and source; purge; restore | A forgotten observation leaves views and indexes and is not restored from a backup taken before it |
| 7 Migration and cutover | Conversion of existing records, index definitions, release | Every existing record is found by the names it was found by before |

### Implementation notes

- **Conversion runs in the service.** The existing records are converted by a bounded pass after each write, by the in-process worker, not by an operator script. It writes no change-feed entry.
- **Indexing has its own queue.** An observation is queued for indexing in its write transaction and indexed after a write; it is found by subject and topic before that. An observation in a compartment the worker may not read is not indexed and stays reachable by key.
- **A view is checked before it is used.** A stored view is returned only when the reader may see every observation it names and none is suppressed; otherwise the view is computed from what the reader may see, as it is for a past date, a full course, linked topics and upcoming states.
- **A course is computed from at most 500 observations**, the latest by recorded time. A longer course is marked truncated.
- **A retraction names an observation of the same topic, or an event.** It is stored even when it has no effect.
- **Forget of a converted observation also forgets the record it came from**, since the record holds the same text.
- **Writer suppression has no tool yet.** The ledger method exists and reads honour it; an operator path to set it is not built.
- **Vector search is not filtered by a field.** Each scope's index is its own collection, which is the bound; disclosure is checked on the results.
- **The check "bounded reads with a large memory present" was not measured.** The queries carry their bounds; no test loads a large memory.

## Evaluation

Three measurements decide whether this model works for the owner. They use real writes and the owner's own questions, and their results go to dated records under `docs/eval/`.

| Measurement | Method | What it decides |
| --- | --- | --- |
| Topic agreement | The share of state observations about one matter, written by different AI clients, that land in one topic | Whether naming guidance and topic links are enough, or the topic key needs another design |
| Name and term search | Japanese, Latin and mixed-script names and short terms at increasing sizes | Whether the built term search is sufficient |
| Questions over time | A set of the owner's questions, including what a state was before, when it changed and what held on a date | Whether the present and the change are returned correctly |

## Open points

- The reading of provider terms for stored summaries, Slack first.
- The wording of the client instructions that makes writers name subjects and aspects alike.
- Whether an event may carry an aspect that groups it with a topic's course when read.
