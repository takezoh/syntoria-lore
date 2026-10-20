# Syntoria Lore

**Long-term memory with evidence for the AIs you authorize.** Lore keeps decisions, preferences, experiences and other useful knowledge with the observations behind them, their speaker and time, and their correction history. An authorized AI can recall that shared memory in a later conversation instead of asking you to repeat everything.

For example, you can ask one AI to remember why a project chose a database, then ask another AI about the decision later. Lore can return the decision with its source and the difference between what was suggested, what you decided and what remains uncertain.

## What Lore remembers

Lore stores reusable memories as facts, decisions, preferences, hypotheses, experiences and procedures. A memory is linked to submitted observations from a conversation, document, tool result or work episode. Lore can store the submitted observation text and permitted evidence excerpts, but it is not the complete archive or source of truth for those documents. A memory's authority describes whose statement it is, not whether an outside claim is true.

You can ask an authorized AI to remember or correct something, look up a current or past decision, see where a memory came from, or forget information. Lore preserves replaced and retracted history differently from forgotten content. It does not manage tasks or calendars or act as a complete archive for the documents it receives; the source system remains the place to retrieve full originals.

When a connected source sends material with consent, Lore can process it in the background. It checks extracted proposals against their source evidence and existing memories. Some proposals may be committed under policy; uncertain, non-fact or conflicting proposals can wait for user review. Recall returns a bounded Context Pack with matching memories and their evidence and uncertainty. The search is not exhaustive, and a returned memory is not a verification of truth.

## Current access

Lore is an API and Remote MCP service; it has no Lore login page or browser app. Signing in and approving a client belong to Gate. To use the hosted service, a compatible client must be configured for its exact resource and the service operator must have an existing Lore identity binding and grant for that client. The repository does not provide public self-service sign-up. See [client access](docs/usage/sign-in.md) for the prerequisites.

## Try a workflow

Examples for remembering, recalling, correcting and forgetting are in [use cases](docs/usage/use-cases.md). Builders can follow the [agent workflow guide](docs/usage/agent-workflows.md) to discover tools, send a memory request, handle a review and recover safely after a lost response.

## Learn how it works

[Product and usage](PRODUCT.md) explains the memory kinds, evidence, attribution and lifecycle. [Architecture](ARCHITECTURE.md) gives developers the service map. The [memory system reference](docs/technical/memory-system.md) follows an observation from capture to retrieval, including the bounded search and deletion paths.

Contributors can start with the [development guide](docs/development.md), which lists prerequisites, local commands, verification boundaries and the documentation map. The current deployment and acceptance evidence is maintained separately in [dated evaluation records](docs/eval/).

## License

No license has been selected yet, so this repository does not grant terms for public use.
