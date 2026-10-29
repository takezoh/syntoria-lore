# Use cases: ask your AI

Tell your AI what to keep, what to look up and what to fix. These prompts are starting points for an AI client that is already connected to Syntoria Lore; adapt them to your own words. Your AI chooses the tools and interprets the results, and Lore keeps each memory with its evidence and history. When the answer matters, ask your AI to show the source.

## Remember a decision

> Remember my decision: we will choose the technology only after the requirements for the finished product are settled.

Your AI saves the decision with the conversation as evidence, and Lore confirms that it was saved. An AI connected with your account writes as you, so a decision saved this way is recorded as yours; it should save only what you actually said.

## Continue in another AI

Tell your coding assistant:

> Remember: this project's API errors use the problem+json format.

Later, in a different AI connected to the same account:

> What error format does this project use? Show me where that came from.

The second AI can recall what you told the first, together with the conversation it came from. Each AI asks Lore when it needs the background, so ask it to check when a conversation depends on earlier context.

## Keep a suggestion separate

> You suggested PostgreSQL earlier. Save it as your suggestion, and keep it separate from anything I decided.

Your AI saves its own idea as a proposal. Lore keeps it as an AI proposal waiting for your confirmation, apart from your decisions. Attribution records who said something; it does not prove the claim is true.

## Recall a past decision

> What did we decide about the Kyoto trip budget in spring? Show me what was still open and where the answer came from.

Your AI can ask for the view at that time and return the supporting memories and evidence. If nothing comes back, the search found no supported match; it does not mean the conversation never happened.

## Correct a changed policy

> The review now happens on Tuesday. Replace the old Monday schedule and tell me when the new one starts.

The Monday schedule is kept as what applied until the change, and the Tuesday schedule applies from the new date. If another AI changed the same memory first, Lore reports a conflict instead of overwriting it, and your AI should look again before proposing the update.

## Retract a wrong claim

> Retract the note that I'm allergic to peanuts. That was never true.

Retraction marks a memory as wrong while keeping a record that it was withdrawn. Use Forget instead when the content should no longer be kept or returned at all.

## Reuse an experience

> Last time the deploy failed with a migration lock timeout. What fixed it, and under what conditions?

Lore can keep a work episode as one experience with its condition, action and outcome. Your AI should compare those conditions with the current situation before reusing the lesson.

## Check a source

> Why do you think I prefer morning meetings? Show me who said it and which conversation supports it.

A returned memory can include its source location, speaker, time and how certain it is. A preference that Lore inferred from a connected source waits for your review before it is treated as yours.

## Review a proposal

> Show me the memories waiting for my review. Explain the evidence and what you would change if I reject one.

When you have connected a source, Lore can propose memories from what it sends. Preferences, decisions, conflicts and uncertain proposals wait for you instead of being saved automatically.

## Catch up after another conversation

> Check what changed in my memories since I last reviewed the project, then summarize the current policy with its source.

Each AI keeps its own place in the change history and catches up from there. A forgotten item appears only as a notice without its content, and your AI should drop any copy it kept.

## Forget information

> Forget the memories about my old address.

Forgotten content stops being returned right away and is deleted in the background; your AI should discard any copy it kept. Backups can retain it until their retention period ends, and a restored service applies the deletion before serving memories again.

For connecting clients and choosing what each one can do, see [client access](sign-in.md). For tool details and recovery, see the [agent workflow guide](agent-workflows.md). For memory kinds, attribution and lifecycle, see [Product and usage](../../PRODUCT.md).
