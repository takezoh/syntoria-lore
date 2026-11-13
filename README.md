# Syntoria Lore

## Remember what matters in a new situation

Lore keeps decisions, constraints and lessons so an authorized AI can use them in a later task without making you explain the same background again. A lesson from another project should help when its conditions fit, with its source and a distinction between what applied then and what applies now.

That is the intended outcome, not a guarantee that every connected AI will remember to search or apply a result correctly. The [evaluation records](docs/eval/README.md) distinguish retrieval, automatic tool use and answer quality.

## Save an observation and keep its history

An AI connected to Lore can record what you said, a source it read, or an inference it made. Each observation retains its writer, subjects, time and available source references. A state holds until it changes; an event records something that happened. When a state changes, Lore keeps the earlier observation and derives the topic's current state.

For example, an AI can record that a project's review happens on Monday, then record a change to Tuesday effective next month. Later, it can retrieve the current schedule, the earlier schedule and the reason for the change, if that reason was recorded.

Your statement, an attributed source and an AI inference remain distinguishable. Attribution does not independently establish that a claim is true.

## Bring earlier context into a new task

Recall accepts a description of the situation, not only a project or file name. It combines name, term and semantic matches and returns permitted evidence. Topic results keep current state alongside matched historical evidence.

An optional assessment can select relevant candidates and explain whether they apply directly, need confirmation or offer a transferable lesson. These explanations are model interpretations, not verified facts. Search can miss evidence, and an empty result does not prove nothing was said. The client must still call Lore and use the evidence appropriately.

## Correct and forget

Record a new state when something changes. Retract an observation when it was mistaken. Ask to forget content when it should stop being returned; Lore records the deletion before removing stored material in the background. Forget cannot erase copies already received by another application or make retained backups disappear immediately.

## Connect an AI

The current service exposes Remote MCP. It has no memory browser, self-service sign-up or served REST adapter. The operator must admit and configure access for the account. In Access mode, authorized AI connections share the mapped account's AI principal; writer metadata does not identify each individual AI product.

Lore does not fetch chat histories or source documents itself. Connected AIs submit observations and attach source references. Policy controls whether a requested action can proceed; there is no implemented user-confirmation UI or pending-review queue. See [Product](PRODUCT.md) for the current behavior and limits.

For connection setup, a copyable initialization prompt, persistent instructions and everyday workflows, see the [user guide](docs/user-guide.md).

## Try these requests

- “Record that I operate the service alone and cannot increase recurring infrastructure spending.”
- “Before proposing a new architecture, recall the relevant constraints and identify what still needs checking.”
- “What was the project's review schedule in October?”
- “Which previous incident offers a useful lesson here? Do not assume its cause is the cause of this incident.”
- “Show the observation and original source behind that claim.”
- “Retract the incorrect timeout explanation.”
- “Forget the observation containing my former delivery address.”

An AI's statement that it saved something is not a storage receipt. Successful writes return an observation ID; failed calls must be corrected before claiming success.

## Develop and operate

- [Product behavior and acceptance](PRODUCT.md)
- [Architecture and responsibility boundaries](ARCHITECTURE.md)
- [Development and local verification](docs/development.md)
- [Operations, configuration, diagnostics and rollback](docs/operations.md)
- [Evaluation guide and recorded limitations](docs/eval/README.md)

Older pages marked historical describe previous implementations. They are not current setup or operating instructions.

## License

No license has been selected yet, so this repository does not grant terms for public use.
