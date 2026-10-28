# Unified AI Platform

One Node.js backend that provides AI for AquaKart, PawSattva, Spasta and future brands. It covers:

- shopping and pet assistants
- SEO blogs
- Instagram posts and reels
- scheduled publishing

Every capability goes through one LLM gateway and keeps each brand's data isolated.

> **Status:** Phase 1 (core infrastructure) is built and tested. Phases 2–6 are not started. See [docs/phases.md](docs/phases.md).
> **Before changing anything, read [AGENTS.md](AGENTS.md).**

## Quick start

Requirements: Node 24+, pnpm 10, MongoDB, and Redis. Docker Compose can provide MongoDB and Redis.

```bash
pnpm install
cp .env.example .env               # then set API_KEY_PEPPER (and OPENROUTER_API_KEY + DEFAULT_LLM_MODEL for LLM calls)
docker compose up -d mongo redis   # or point MONGODB_URI / REDIS_URL at your own instances

pnpm seed                                              # creates aquakart, pawsattva, spasta in the platform DB (idempotent)
pnpm api-client:create --name ops --platform           # prints a platform-admin key ONCE
pnpm dev:api                                           # http://localhost:4000, docs at /docs
pnpm dev:worker                                        # background worker (separate process)
```

Try it:

```bash
curl -H "Authorization: Bearer <platform key>" http://localhost:4000/api/v1/brands
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev:api` / `pnpm dev:worker` | Run with reload (tsx). Loads `.env` from the repo root. |
| `pnpm typecheck` | Strict type check of the whole workspace |
| `pnpm test` | Vitest: unit tests plus API integration tests against in-memory MongoDB |
| `pnpm build` | Bundles `apps/api` and `apps/worker` into `dist/` |
| `pnpm seed` | Seeds the brands collection. Never overwrites existing brands. |
| `pnpm api-client:create` | Bootstrap CLI for API keys (`--platform`, or `--brand <slug> --scopes a,b`) |

## Layout

```text
apps/api            Fastify REST API (OpenAPI at /docs)
apps/worker         BullMQ worker process
packages/config     env validation (fails fast; optional integrations all-or-nothing)
packages/core       errors, logger (pino, with secret redaction), backoff, semaphore
packages/shared-types  roles, scopes, principal, content states
packages/database   Mongo connection with retry, models, tenant-scoped repositories
packages/auth       API keys, Firebase/JWKS token verification, scopes, brand access
packages/llm-gateway  provider-agnostic gateway: routing, fallback, retries, budgets, usage
packages/integrations/openrouter  OpenRouter provider (chat + SSE streaming + tools + JSON)
agents/             AI agent definitions (from Phase 3; see agents/README.md)
docs/               spec, architecture, API, security, integrations, decisions
infrastructure/     Dockerfile; deployment notes (Phase 6)
```
