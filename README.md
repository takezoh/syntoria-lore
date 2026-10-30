# Syntoria Lore

## Explain it once. Every AI you authorize can remember it, with the reason.

**Your decisions, preferences and lessons stay with who said them, when they applied and what changed, so your next conversation can start from what you already explained—even in another AI you use.**

Syntoria Lore is Syntoria's Memory Service: long-term memory with evidence for the AIs you authorize. You and your AIs save what is worth keeping. Later, any of those AIs can recall it together with its source, its history and what is still uncertain.

Tell one AI, “We'll choose the database only after the product requirements are settled.” Next month, ask a different AI what the project decided. It can answer with your decision, when you made it and the conversation it came from—and keep it apart from the database it had suggested before.

## Explain it once

Ask any AI connected to your account to remember a decision, a preference or a lesson. In a later conversation, or in another AI connected to the same account, ask about it and it can be recalled instead of explained again. Each AI asks Lore when it needs the background, so ask yours to check its memory when the context matters.

## See why your AI knows it

Every memory keeps the evidence behind it: what was said, by whom, where and when. Your decision, your AI's suggestion and what someone else said stay distinct, so you can tell what you decided from what was only proposed, and which AI wrote what. Ask “where did that come from?” and get the source, not just a confident answer.

## Correct it without losing what was true

Plans change and mistakes happen, and Lore records them differently. When a policy changes, the old one is kept as what applied until then. When something was simply wrong, it is retracted rather than silently overwritten. When sources disagree, a memory can be marked as contested instead of quietly picking a winner. You can ask what applied last spring, or what your AI knew at the time.

## Decide what is kept and forgotten

Lore keeps what you and your AIs send it. Background capture from a conversation or document source starts only after you approve that source; Lore does not fetch your chat history on its own. Proposed memories that need your judgment, such as preferences, decisions and conflicts, wait for your review. Ask to forget something and approve it, and it stops being returned right away, then is deleted from Lore's records in the background.

## Keep work and private life apart

Your memories can belong to private life, an employer, a client or several businesses at once. Put them in compartments, and each AI you connect receives only general memories and the compartments you give it. A newly connected AI starts with general memories only. Anything derived from a memory keeps its restrictions, and moving a memory to where more AIs can see it is a change your approval policy decides.

## Who it is for

If you use more than one AI assistant and keep explaining the same background, decisions and preferences, Lore lets you say them once. If you make lasting decisions in conversation and later need to know who said what and why, Lore keeps the reason with the memory. If you build your own agents or workflows, they can remember and recall through the same REST and Remote MCP tools.

Lore is personal memory for your own account. It does not track tasks or the current state of your work—that is [Syntoria Weave](https://github.com/takezoh/syntoria-weave)—and it is not a complete archive of your documents.

## Connect an AI client

Lore works through REST and Remote MCP; it has no app or sign-in page of its own. Your AI client signs you in through Gate, the shared sign-in service, and connects to Lore's single MCP URL. Lore makes each read or write operation available according to the capabilities granted to the mapped Lore principal; clients using the same Gate account share that principal's permissions. The service operator must first admit your Gate account to Lore; there is no self-service sign-up yet, and end-to-end use with a hosted AI client has not been verified. See [client access](docs/usage/sign-in.md).

## Use cases: ask your AI

Use your own words. For example:

- “Remember my decision: we'll pick the database only after the product requirements are settled.”
- “You suggested PostgreSQL earlier. Save it as your suggestion, separate from what I decided.”
- “What did we decide about the Kyoto trip budget in spring? Show me where the answer came from.”
- “The review now happens on Tuesday. Replace the old Monday schedule from next week.”
- “Retract the note that I'm allergic to peanuts. That was never true.”
- “Last time the deploy failed with a migration lock timeout. What fixed it, and under what conditions?”
- “Show me the memories waiting for my review.”
- “Forget the memories about my old address.”

See [use cases and example prompts](docs/usage/use-cases.md) for continuing in another AI, checking a source, reviewing proposals and catching up after another conversation. Builders can start with the [agent workflow guide](docs/usage/agent-workflows.md).

## How it works

Lore stores memories and their evidence; your AI decides when to remember or recall and what a result means for the task at hand. An explicit request to remember is saved immediately. When a connected source sends conversations or documents, Lore's background curator proposes memories, checks each one against the cited source text and existing memories, and saves only uncontested facts automatically. The rest wait for your review.

Lore tells what you decided apart from what an AI wrote. Every AI you connect acts for you but not as you: what it saves is kept as an AI proposal, together with which AI saved it. When an AI asks to record a decision, preference or correction as yours, or to Forget or change what Lore keeps, your approval policy decides. With automatic approval, the default, Lore applies it at once and records that your policy approved it, not you, and which AI asked. If you choose to approve each change yourself, your AI shows you a link to Gate, the shared sign-in service; you sign in, read the change as Lore describes it and approve or deny it. Attribution says who said something, not whether it is true.

Recall returns a bounded set of matching memories with their evidence and uncertainty. It can miss things, and an empty answer does not prove that nothing was said. Forgotten content stops being returned immediately; backups may hold it until they expire, and a restored service applies the deletion before serving memories again.

## What a memory contains

Each memory has a kind—fact, decision, preference, hypothesis, experience or procedure—a statement, the evidence it came from, who it is attributed to, when it applies and its revision history. An experience can keep the condition, action and outcome together, so a later AI can judge whether the lesson fits a new situation.

See [Product and usage](PRODUCT.md) for the meaning of these building blocks.

## License

No license has been selected yet, so this repository does not grant terms for public use.

[Product and usage](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Development and verification](docs/development.md)
