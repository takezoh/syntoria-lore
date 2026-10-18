# Syntoria Lore

## Explain it once. Every AI you use remembers—and knows why.

**Long-term memory with evidence for your AIs. What you decided, what you prefer and what you learned are kept with their source, the time they hold and every correction, so a new conversation does not start from zero.**

Syntoria Lore is Syntoria's Memory Service: long-term memory with evidence, shared by the AIs you authorize. It turns conversations, documents, tool results and work episodes into reusable memories—facts, preferences, decisions, hypotheses, experiences and procedures—and keeps each one with where it came from, where it applies, when it holds and how it has been corrected.

Months ago you told one AI, “Choose the technology only after the requirements for the finished product are settled.” Today you ask a different AI where the project stands. It recalls that rule as your decision, points to the conversation where you said it, and keeps it apart from the database an AI once suggested. You spend less time re-explaining yourself and correcting mix-ups, and more on the work itself.

## Stop re-explaining yourself

Tell your AI to remember a decision, a preference or a correction. It is saved at once, and the next recall—in another conversation, from another AI—already knows it. Conversations and documents you choose to share are organized in the background: no tagging, filing or summarizing on your part.

## See where every memory came from

Each memory keeps its evidence: the source, who said it, when it happened and when Lore learned it. Ask why your AI believes something and it can show you the original. Repeating the same summary does not count as new evidence, and two independent sources stay two.

## Your decisions stay yours

An AI's suggestion is remembered as the AI's suggestion; it becomes your decision only when you make it. A colleague's claim stays theirs. Your own technical claim is remembered as your claim, not as a verified fact.

## Corrections stick

Change your mind, and the earlier decision becomes history instead of being deleted or silently overwritten. Reprocessing an old document cannot bring back a policy you have already replaced. After a rename, “what is it called now?” and “what was it called in March?” each get the right answer.

## Gaps are named, not filled

When evidence is missing, conflicting or possibly out of date, Lore says so. Your AI receives the gaps and contradictions together with the memories, so it can ask you instead of guessing.

## Forget means forget

Ask to forget something and it disappears at once from every recall, change feed and export; its content is then deleted. A database restored from an older backup stays closed until it has reapplied every deletion, so forgotten content does not come back.

## Who it is for

If you work with several AIs and keep restating the same background, Lore gives them one memory. If decisions happen in conversation, Lore keeps who decided what, when and on what grounds. If you build your own agents, they can read through a read-only connection and write only where you allow it.

Lore is a personal service: your memories belong to your account and are not shared with other accounts. It is not a task list, a calendar or an archive of your documents.

## Sign in and connect your AI

Your account protects your memories with a password and an authenticator app. The [sign-in guide](docs/usage/sign-in.md) covers first sign-in, return visits and recovery.

Connecting AI assistants to the hosted service is not open yet; the service currently runs privately. Signing in does not by itself give any AI access to your memories: each AI receives its own permission, read-only or with write access.

## Use cases: ask your AI

Use your own words. For example:

- “Remember: we choose the stack only after the finished-product requirements are settled.”
- “What did we decide about the database, who decided it, and why?”
- “What was the plan in March, before we changed it?”
- “The deploy failed like this before. What fixed it, and when does that fix not apply?”
- “That's wrong: the review moved to Tuesday. Correct it.”
- “What has changed in what you remember since yesterday?”
- “Show me where that came from.”
- “Forget everything about my old address.”

See [use cases and example prompts](docs/usage/use-cases.md) for remembering decisions, recalling the past, correcting and forgetting, and building agents on the same memory.

## How it works

Lore manages what is remembered, on what evidence and how; your AI decides when to remember or recall, how to read what comes back, and what to do next. Explicit remembers and corrections are confirmed immediately. Material from sources you have enabled is curated in the background: Lore extracts candidate memories, matches them with what it already knows and keeps anything uncertain or important for your review.

Recall returns a **Context Pack**: the memories that fit the question and your AI's context budget, each with its evidence, together with contradictions, unknowns and how current the answer is. A change feed lets each AI catch up on what changed since it last looked.

Lore does not hold your current to-dos or pending decisions; that shared state belongs to Syntoria Weave. Lore and Weave are separate services, and your AI uses both when it needs both.

## What a memory contains

Each memory has a **kind**—fact, preference, decision, hypothesis, experience or procedure—a statement, the **evidence** that supports or contradicts it, and two times: when it holds and when Lore learned it. An experience keeps its condition, action and outcome together. Every change creates a new **revision**: replaced memories remain as history, retracted ones are marked as wrong, and forgotten ones are removed.

See [Product and usage](PRODUCT.md) for the meaning of these building blocks.

## License

No license has been selected yet. Until one is added, no terms for public use are granted.

[Product and usage](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Development and verification](docs/development.md)
