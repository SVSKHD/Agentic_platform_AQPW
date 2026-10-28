# Phase status

Updated 2026-10-25. Each phase is reported in the format required by spec §21. "Verified" means exercised by a test or a real run, as stated.

## Phase 1: Core infrastructure (complete)

### Implemented

- **Monorepo:** pnpm workspaces, strict TypeScript, internal packages exported as source, apps bundled with tsup.
- **Config:** validated env that fails fast; optional integration groups are all-or-nothing; staging and production guardrails.
- **API (Fastify 5):**
  - request ids and secret-redacting pino logs
  - helmet and a CORS allowlist
  - Zod validation and response allowlists
  - one standard error shape
  - OpenAPI at `/docs`
  - liveness and readiness checks
  - graceful shutdown
- **MongoDB:**
  - dedicated connection with initial-connect retry and reconnect logging
  - models: `brands`, `applications`, `api_clients`, `llm_usage_logs` (TTL), `audit_logs` (TTL)
  - repositories that require a `brandId`
- **Redis:** connection and readiness check. The worker process runs a BullMQ `maintenance` queue.
- **Auth:**
  - hashed API keys
  - Firebase and JWKS end-user token verification per application
  - anonymous mode, scopes, brand isolation, delegation limits
  - bootstrap CLI and idempotent brand seed (aquakart, pawsattva, spasta)
- **LLM gateway:**
  - provider interface; routing with fallback
  - retries with backoff and `Retry-After`; one deadline across attempts; cancellation
  - concurrency cap; per-brand daily and monthly token and cost budgets
  - usage and cost logging; structured JSON output validated with Zod; streaming; tool calling
  - error normalization
- **Brand-owned roles:** the PawSattva role resolver reads `admin`, `role`, `blacklisted` and `restrictedEmails` from Firestore and maps them to platform roles and scopes. It fails closed when not configured. Covered by unit and API tests ([ADR 0003](decisions/0003-brand-backend-vs-agentic-layer.md)). Not yet run against the real PawSattva project.
- **OpenRouter provider:** chat, SSE streaming (including tool-call deltas and final usage), tools, json_schema output, error and Retry-After mapping.
- **Brand-scoped API:**
  - brands
  - applications
  - API clients
  - `POST /api/v1/llm/completions`
  - `GET /api/v1/auth/me`

### Tests

`pnpm test` gives 90 passing tests in 8 files:

| Area | What is tested |
|---|---|
| Config | Env validation and guardrails |
| Auth | Keys, tokens, anonymous mode, origin, scopes, isolation |
| PawSattva roles | Role mapping, blocked and unknown users, fail-closed, no platform admin for brand users |
| Gateway | Routing, retry, fallback, timeout, cancellation, concurrency, budgets, JSON output, streaming rules |
| OpenRouter | Wire mapping, error mapping, SSE parsing |
| MoneyPrinterTurbo client | Request mapping, task states, error mapping, SSRF-safe downloads |
| Database (real mongod, in memory) | Seed idempotency, tenant-scoped queries, usage aggregation, TTL indexes |
| API integration (real Fastify + mongod) | Every route, cross-brand denial, escalation, budget enforcement, usage attribution, revocation, audit |

`pnpm typecheck` and `pnpm build` are clean.

### Verified by a real run

The **built** API bundle was started against a real `mongod` process. Redis was a minimal stand-in that answers PING, which is enough for the readiness check. The checks:

- seed run twice (no duplicates)
- CLI key minted
- `/health/ready` returns 200
- cross-brand request returns 403
- LLM call without OpenRouter configured returns 503 `not_configured`
- OpenAPI served

`pnpm deploy` production installs for the API and the worker resolve every runtime module.

### Not verified

- **No real OpenRouter call was made**, because no key was available. The provider is tested against recorded wire formats only. **First step once `OPENROUTER_API_KEY` is set:** make one real call to `/api/v1/llm/completions` and one streaming call, and confirm that `usage.cost` is populated.
- **The worker has not processed a job against real Redis.** BullMQ needs a real Redis.
- Docker image and Compose: written, never built.
- Graceful shutdown on Linux.
- Firebase token verification against a real Firebase project. The verifier is tested through its interface only.

### Credentials and contracts still needed

| Item | Needed for | Phase |
|---|---|---|
| `OPENROUTER_API_KEY` and a `DEFAULT_LLM_MODEL` choice | Gateway | 1 (verification), 2 |
| Firebase project id for PawSattva's web app | User token verification in Paw GPT | 2 |
| PawSattva Firebase service account (`FIREBASE_*`) for direct Firestore writes | Blog drafts, SEO | 3 |
| AquaKart least-privilege MongoDB user + `AQUAKART_MONGODB_URI` (see [integrations/aquakart.md](integrations/aquakart.md)) | Catalog, blogs, SEO | 2–3 |
| ~~Confirmed AquaKart collection names~~ (done 2026-10-25, from model code; see [integrations/aquakart.md](integrations/aquakart.md)) | Writing that user's role | 2 |
| Spasta: website, stack, content focus | Everything for that brand | — |
| Answers to the open questions in [integrations/pawsattva.md](integrations/pawsattva.md) | Categories, images, Paw GPT ownership | 2–3 |

### Limitations

- No HTTP rate limiting yet (Phase 2).
- Budget windows are UTC.
- Concurrency limits are per process.
- `/llm/completions` only accepts plain text messages; tools and streaming are only available inside the gateway for now.

## Phase 2: Live AI chat (not started)

Planned:

- chat sessions and messages
- SSE streaming endpoint
- assistant configs
- tool runner with authorization
- Redis rate limiting and quotas
- AquaKart catalog adapter (read-only `all-products?query=ecom`)
- Paw GPT with veterinary escalation, using PawSattva Firestore for quotas, pet context and chat history (`users/{uid}/pawGptChats`; see [integrations/pawsattva.md](integrations/pawsattva.md))

## Phase 3: Content automation (not started)

**Owner requirement: PawSattva daily blog and Instagram flow** (Phases 3–4). Every day at **06:00 IST**:

```text
06:00 IST  topic selection   (skip topics already covered in blogs; contentGoals type "blog" can seed topics)
   → research + blog article (Paw GPT voice, no medical claims, vet escalation wording)
   → featured image          (1:1 or 4:5, on an allowed host: PawSattva Firebase Storage)
   → Firestore blogs doc     status "pending_review", instagramAutoPost: true, instagramCaption set
   → [review]                PawSattva admin approves in /admin
   → Instagram post          the blog's image + caption + link, via the Meta Graph API
   → write back              instagramPostId / instagramPostStatus / instagramPostError on the blog
```

**Status, checked 2026-10-25:**

- **Not automated anywhere.** PawSattva has no scheduler, and no code on this machine calls its draft endpoint.
- **PawSattva's "Approve" button does not post to Instagram.** Only saving as published from the blog form does (`admin-panel.tsx:976`). The platform will watch for its drafts changing to `published` and post them itself. That post is idempotent: an existing `instagramPostId` means it is already done.
- **`/api/instagram/publish` is unauthenticated.** Once the platform posts, it should be removed or protected.

**Needs:**

- Image generation provider (Phase 4)
- Meta Graph credentials for PawSattva's Instagram business account
- Firebase Storage write access for images

**Open:**

1. Publish automatically every day, or wait for admin approval? The spec defaults to approval-first. With approval, Instagram posts only after an admin approves.
2. Where do topics come from: the platform picks them, an admin-maintained list (for example `contentGoals`), or both?
3. Blog only on Instagram, or also a carousel or reel from the same topic (spec §10 campaign)?

**Owner requirement: a 10-day SEO cycle for AquaKart and PawSattva.** Every 10 days:

- generate new blog draft(s)
- refresh the SEO keywords, keyphrases and descriptions of existing content

Each run is an agent job and follows the 2-attempt failure limit.

**Schedule (owner decision, 2026-10-25):**

- The deadline is every 10 days (`SEO_CYCLE_DAYS=10`).
- Suggestions and drafts are generated **on day 9** (`SEO_SUGGESTION_LEAD_DAYS=1`), so reviewers have a day before the deadline.
- Approved changes are applied when they are approved.
- Nothing is applied without approval.
- Items still unapproved at the deadline are flagged overdue and stay pending. The next cycle skips content that already has a pending suggestion.

Both values are in `packages/config` and validated: the lead must be shorter than the cycle.

**Where it is written (owner decision, [ADR 0002](decisions/0002-direct-writes-pawsattva-aquakart.md)):**

| | New blog drafts | SEO refresh |
|---|---|---|
| PawSattva (Firestore) | `blogs` doc with `status: "pending_review"`, reviewed in PawSattva `/admin` | Needs a non-live suggestion location (open item 1) |
| AquaKart (MongoDB) | `AquaBlog` with `status: "draft"`, `generatedBy: "ai"`, reviewed in AquaKart admin | Same: `AquaSeo` has no pending state |

At cut-over, disable AquaKart's own `blog-ai-drafts` (daily) and `seo-ai-refresh` (weekly) jobs.

**Still open:**

1. **Where SEO suggestions wait for review.** Writing them straight into live SEO fields would skip review. Options:
   - (a) a suggestion field or collection inside each app, plus a small review view in each app's admin
   - (b) suggestions held in the platform's `approval_requests`, approved through the platform API
2. How many blog drafts per brand per cycle?
3. Which content is refreshed: blogs only, or product, category and page SEO too? Should staff-edited or `aiLocked` content be skipped?

Planned:

- campaigns and content briefs
- research, blog and review agents
- approval state machine with audit
- automation engine (queues, idempotency, dead-letter queue)
- PawSattva Firestore adapter (`pending_review` drafts, write guard)
- AquaKart MongoDB adapter (`draft` blogs, dpPrice-free catalog reads, least-privilege user)

## Phases 4–6 (not started)

| Phase | Scope |
|---|---|
| 4 | Instagram (Meta Graph API) |
| 5 | Reels. Rendering by self-hosted MoneyPrinterTurbo ([ADR 0004](decisions/0004-moneyprinterturbo-render-provider.md)) for PawSattva and AquaKart. The client `@uap/moneyprinter` is **built and unit-tested**, and has not run against a live MPT. Still to build: worker job, S3 storage, FFmpeg logo watermark and thumbnail, approval, and Instagram Reel publishing. |
| 6 | Hardening: rate limits, monitoring, load and security testing, deployment guide |

Section 16 (admin dashboard) was removed from the scope by the owner.
