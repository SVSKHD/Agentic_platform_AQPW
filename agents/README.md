# Agents

AI agents from spec §6 live here, one folder per agent. **None are implemented yet.** The first ones come in Phase 3. This file defines the contract they must follow, so that agents are consistent from the first one onward.

## Contract (applies to every agent)

An agent is a **bounded, typed workflow**, not a free-running LLM loop.

- **Typed input and output.** Use a Zod schema for each. Get output with `gateway.chatJson(…)` and validate it before using it.
- **Deterministic steps.** Every LLM call is one named step.
  - Tool use is limited by an explicit maximum number of iterations.
  - Each step has a timeout and a token budget.
- **Gateway only.** Every model call goes through `LlmGateway` with a `RequestContext`.
  - The context carries `brandId`, `agentId`, `requestId` and, where relevant, `sessionId`.
  - Usage and cost are then attributed automatically.
- **Configuration is data.** An `agent_configs` document (Phase 3) holds:
  - model route
  - instructions
  - allowed tools
  - limits
  - approval requirement
  - version
  
  Config is versioned, and each execution records the version it ran with.
- **Tools are allowlisted per agent.** Tool implementations live in `packages/integrations/*` or the engines, never in the agent.
  - Agents cannot call arbitrary URLs, run code, or reach databases they are not granted.
- **Output is a draft.** Content agents produce `GENERATED` content. Publishing goes through the approval workflow (spec §12).
- **At most 2 attempts.** This is an owner rule. A job runs once, retries once, and after the second failure stops as `FAILED`.
  - The job then goes to the dead-letter queue with its error and last completed step, for human review. It is never retried automatically again.
  - Use `config.agents.maxAttempts` as the BullMQ `attempts` value; never hardcode it.
  - Some errors fail immediately with no retry: `budget_exceeded`, `not_configured`, `auth`, `bad_request`.
  - A retry resumes from the last saved step, so completed steps are not paid for twice.
- **Work runs in the worker.** Agents run as BullMQ jobs in `apps/worker`, never inside an API request, except the two chat assistants.

## Planned agents

| Folder | Agent | Phase | Notes |
|---|---|---|---|
| `research/` | Research Agent | 3 | Produces the campaign research brief and verified facts that all content reuses (spec §10). |
| `blog/` | SEO Blog Agent | 3 | Outline, then article, then SEO validation. Drafts go to Firestore (`pending_review`) for PawSattva and MongoDB (`draft`) for AquaKart. |
| `review/` | Content Review Agent | 3 | Checks facts and claims (no medical claims for PawSattva) and SEO hygiene. |
| `instagram/` | Instagram Content Agent | 4 | Captions, hashtags, carousel copy, from the campaign brief. |
| `image/` | Image Generation Agent | 4 | Uses a separate image-provider interface, not the text gateway. |
| `reels/` | Reel Script, Voiceover and Video Assembly agents | 5 | The script comes from the gateway. Voice, footage, subtitles and render come from self-hosted MoneyPrinterTurbo through `@uap/moneyprinter` ([integrations/moneyprinter.md](../docs/integrations/moneyprinter.md)). PawSattva and AquaKart only. |
| `publishing/` | Publishing Agent | 4 | Idempotent publishing to Meta and the brand sites. Never bypasses approval. |
| `aquakart-shopping/` | Shopping Assistant | 2 | Real-time chat. Prices and stock come only from AquaKart data. |
| `pawsattva-paw-gpt/` | Paw GPT | 2 | Real-time chat. Escalates to a vet for emergencies; never diagnoses. |
