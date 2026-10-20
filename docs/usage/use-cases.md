# Ask your AI to use Lore

These prompts are examples for an AI client that already has the right Lore tools and access. Your AI must choose and call those tools; a prompt by itself does not grant permission or make a memory change. Ask it to show the source and uncertainty when the answer matters.

## Remember a decision

> Remember my decision: we will choose the technology only after the requirements for the finished product are settled.

The AI should save the decision with the conversation evidence, then confirm whether Lore accepted it. A client cannot assign itself the user's authority. If it submits its own proposal, Lore may keep it as a candidate for user review.

## Keep a suggestion separate

> You suggested PostgreSQL earlier. Show it as your suggestion, and keep it separate from anything I decided.

Lore preserves who made a claim and what evidence supports it. That attribution does not prove the claim is true.

## Recall a past decision

> What did we decide about the Kyoto trip budget in spring? Show me what was still open and where the answer came from.

The AI can request historical recall and return supporting memories and evidence. Search is bounded; an empty result means the query returned no supported match, not that the conversation never happened.

## Correct a changed policy

> The review now happens on Tuesday. Replace the old Monday schedule and tell me when the new one starts.

For a change, the client reads the current revision and submits a correction against that revision. If another writer changed it first, Lore reports a conflict and the AI should recall again before proposing the update.

## Retract a wrong claim

> Retract the note that I'm allergic to peanuts. That was never true.

Retraction marks a memory as wrong. It does not delete it as if it had never been stored; use Forget when the content should no longer be retained or returned.

## Reuse an experience

> Last time the deploy failed with a migration lock timeout. What fixed it, and under what conditions?

Lore can keep a work episode as one experience with its condition, action and outcome. Your AI should compare those conditions with the current situation before reusing the lesson.

## Check a source

> Why do you think I prefer morning meetings? Show me who said it and which conversation supports it.

A returned memory can include its source location, speaker, event time and epistemic status. Inferred preferences may be held for review; source attribution is not an independent verification of an outside-world fact.

## Review a proposal

> Show me the memories waiting for my review. Explain the evidence and what you would change if I reject one.

Capture can produce candidates when the source is enabled and sends observations to Lore. Non-facts, conflicts, uncertain proposals and ambiguous matches may wait for the user instead of being committed automatically.

## Catch up after another conversation

> Check what changed in my memories since I last reviewed the project, then summarize the current policy with its source.

Each client follows its own change cursor. The AI must save and advance that cursor only after it applies the returned page, or recall afresh if the cursor expires or access changes. A deleted item appears as a content-free notice; the client should remove any cached copy it controls.

## Forget information

> Forget the memories about my old address.

Only a user-authorized request can perform Forget. The selected content is suppressed immediately and purged asynchronously; the AI should follow the request status and discard any cached copy. A backup can retain bytes until its retention period ends, and a restored service must reconcile deletions before serving protected reads.

## Give clients different access

> Let my research assistant read my memories. Let my coding assistant save project decisions.

The service operator must configure the existing client bindings and grants. A client with read access can recall and follow changes; write access permits memory writes within its grant. `admin` is an internal capability on a personal account, not a separate Lore administrator account.

For client setup and tool recovery, see the [agent workflow guide](agent-workflows.md). For the memory kinds, attribution and lifecycle, see [Product and usage](../../PRODUCT.md).
