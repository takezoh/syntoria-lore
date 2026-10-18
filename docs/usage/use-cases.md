# Use cases: ask your AI

Tell your AI what to remember, what to look up and what to correct. These examples are starting points for your own prompts. Syntoria Lore keeps long-term memory with evidence for the AIs you authorize. Your AI decides when to remember or recall and how to use the answer; Lore keeps each memory with its source, its time and its corrections.

## Remember a decision once

> Remember this as my decision: we choose the technology only after the requirements for the finished product are settled.

Lore saves it at once as your decision, with this conversation as its evidence. The next time any of your AIs asks about the project's direction, the decision comes back with who made it and when. You do not have to repeat it in each new conversation.

## Keep a suggestion a suggestion

> You suggested PostgreSQL earlier. Keep that as your suggestion, not my decision, until I've looked at the requirements.

An AI's recommendation stays attributed to the AI. It does not turn into your decision unless you make it one, and later recall shows the difference.

## Pick up a topic from months ago

> We talked about the Kyoto trip budget back in spring. What did we decide, and what was still open?

Your AI recalls the decisions with their evidence and lists what was never settled. If the evidence is thin or two notes disagree, it tells you instead of filling the gap.

## Ask about the past, not just the present

> What was our deployment policy in September, before we changed it?

Lore keeps replaced decisions with the period in which they held. Recall can answer for a specific time, and can also tell you what was known at that time.

## Correct a mistake

> That's wrong: the weekly review moved to Tuesday, not Monday. Correct it.

The corrected memory replaces the old one, and the old version stays in history as superseded. If something was simply wrong rather than changed, say so:

> Retract the note that I'm allergic to peanuts. That was never true.

A retracted memory is marked as wrong instead of being kept as past truth.

## Reuse a lesson

> Last time the deploy failed with a migration lock timeout. What fixed it, and under what conditions?

Lore keeps an experience as one unit: the situation, what was done and how it turned out. Your AI can reuse the fix and see when the conditions differ.

## See where a memory came from

> Why do you think I prefer morning meetings? Show me the source.

Each memory points back to the conversation, document or tool result it came from, with the speaker and time. If a preference was inferred rather than stated, the evidence shows that too.

## Review what is waiting for you

> Show me the memories waiting for my review and explain each one.

Some candidates—your preferences, decisions, and anything that conflicts with what Lore already knows—wait for your confirmation instead of being saved automatically. You can accept a candidate, confirm it in your own words, or reject it.

## Catch up after working elsewhere

> I corrected the release date in another conversation yesterday. Check what changed in my memories since then before you plan the next step.

Each AI can follow the changes since it last looked, including corrections made through another AI. A removed memory appears only as a notice that it was removed, never with its content.

## Forget something

> Forget everything about my old address.

The memory disappears from every recall, export and change feed at once, and its content is then deleted. Lore keeps only a content-free record that a deletion happened, so the content cannot come back from a restored backup either.

## Let several AIs share one memory

> You're my research assistant: you may read my memories but not change them. My coding assistant can save what we decide about the project.

Each AI gets its own permission. A read-only connection can recall and follow changes; a write connection can also remember, correct and forget. Lore records which AI wrote what.

## Take your memory with you

> Export my memories for the project scope so I can move them to a new environment.

An export is encrypted and keeps memories, evidence and history. When it is imported elsewhere, the original attribution is preserved as history rather than turned into fresh decisions.

For tool discovery, connections and building your own agents, see the [workflow guide](agent-workflows.md). For the meaning of kinds, evidence and lifecycle, see [Product and usage](../../PRODUCT.md).
