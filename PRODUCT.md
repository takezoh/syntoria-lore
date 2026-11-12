# Syntoria Lore — Product

Lore is long-term memory for the AIs authorized to work with a person. It keeps submitted observations and their evidence so later conversations can use earlier decisions, constraints and experiences.

## Outcome and acceptance

Success means an AI brings relevant earlier context into a new situation without asking the person to repeat it or explicitly request a search. It must preserve applicable constraints, distinguish prior-project facts from transferable lessons, and let the person inspect supporting evidence.

Saving information, retrieving a candidate and mentioning a constraint are intermediate capabilities. Acceptance also requires correct application, appropriate abstention, no unnecessary memory in unrelated tasks, and truthful save acknowledgements. Reliable spontaneous reuse remains unproven; [dated evaluations](docs/eval/README.md) record the observed improvements and failures.

## What people can do

| Need | Current behavior |
| --- | --- |
| Carry a decision or constraint into another conversation | An authorized AI can append an observation and another authorized connection can recall it |
| Keep current and previous states apart | Lore derives a topic's state from its observation history and supports reads at a specified time |
| Find a lesson without remembering its project name | Contextual recall combines lexical and semantic candidates; relevance and applicability still need evaluation |
| Inspect why an AI knows something | Observations retain subject, writer, effective/recorded time and any submitted source references |
| Correct a mistake without rewriting history | A retraction withdraws an earlier claim according to authority rules |
| Stop returning selected content | Forget records suppression before background purge; restore reconciles the deletion ledger |

## Observations and topics

An observation is a self-contained statement about named subjects. It is either a **state**, which holds until it changes, or an **event**, which happened at a time. A state's aspect names the matter it describes, such as review schedule or spend cap. One subject and aspect form a topic.

An observation may have a kind such as decision, fact, preference, plan, lesson or procedure. That label does not establish truth or authority. A topic result can contain current and previous states, conflicts, and the earlier evidence that matched the query. A history request can return the course of the topic. Reads are bounded and may be truncated.

## Authority and attribution

The authenticated connection and controlled approval policy determine authority. A request or model-generated label cannot grant it.

- **Person:** a write requesting the person's authority, granted by the configured approval policy.
- **Source:** an observation attributed through the applicable source-reference path.
- **Inference:** an AI observation without person authority or qualifying source evidence.

Automatic approval records that the policy approved the exact change; it does not establish that a person reviewed it. A lower-authority observation cannot retract a higher-authority one. An AI recommendation is not a user decision merely because it was saved.

Access mode maps authorized clients to one shared AI principal. The stored writer then identifies that shared principal, not the individual client product. The legacy Gate path and test configurations can have different connection identities; their results must not be generalized to Access mode.

A source link and a reader's report about that source help explain a claim. They do not independently verify it. Lore does not fetch originals or continuously check whether they changed.

## Capture and save acknowledgements

Connected clients decide what to submit. Lore does not ingest conversations or browse Google Drive, Slack or other sources by itself. An integration reading a source should submit a summary and references under the caller's permissions.

A successful `observe` call returns an observation ID and receipt. Clients must inspect tool success before saying information was saved. An invalid call is not a pending observation. There is no current review queue, background extraction curator or implemented user-confirmation UI; a policy requiring unavailable confirmation can reject a protected operation.

Semantic indexing has its own queue. A successful write can be readable by ID before it becomes semantically discoverable. Retry behavior and its operating limits are described in [operations](docs/operations.md#indexing-and-recovery).

## Recall and applicability

Contextual recall accepts the full task and situation. Entity intent prioritizes named subjects. Historical intent and explicit effective-time queries serve different purposes; an effective state on a date is not proof that an event occurred that day.

Recall checks the caller's permissions and suppression rules. It returns bounded matching observations and topic evidence, including subjects, times and sources. Matching signals identify retrieval channels; they do not establish truth or applicability.

When the operator enables applicability assessment, Lore can remove candidates judged irrelevant and attach explanations distinguishing direct use, conditional use and transferable lessons. These annotations are explicitly unverified model interpretations. The original evidence remains authoritative, and the model may misclassify a useful memory. Provider failure is reported and falls back to unannotated retrieval. The feature is disabled by default.

The client must initiate recall and apply results. Lore's MCP instructions guide that behavior but do not force it. A controlled client integration can retrieve before answering; it must still avoid treating similarity as proof of a current cause or of shared constraints.

## Access, compartments and forgetting

The current API is Remote MCP. Operator admission and authenticated account mapping are prerequisites. General and explicitly allowed compartments limit what a connection can read and write. A confidentiality label is not an access grant. No self-service permission-management or source-revocation tool is currently provided.

Forget denies further protected reads before purge removes material from the observation store and derived indexes. Other clients may retain previously delivered content. Backups can retain deleted data until their retention period ends; restore readiness depends on reconciling the independent deletion ledger before serving reads.

Do not delete identity bindings or rewrite data as an administrative workaround. The [operations guide](docs/operations.md) describes the controlled paths and unresolved recovery limitations.

## What is not established

There is no guarantee of exhaustive recall, independent verification of source claims, stable automatic use across AI products, large-corpus performance, or cost feasibility of a model-generated recommendation. Local emulator checks do not validate managed indexes, hosted authentication, operational billing or extraction quality.

[Architecture](ARCHITECTURE.md) owns implementation boundaries. [Situational recall](docs/design/situational-recall.md) owns the acceptance contract, and [evaluation records](docs/eval/README.md) own dated observations. Historical documents describe earlier models rather than current behavior.
