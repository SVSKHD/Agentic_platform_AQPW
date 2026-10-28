# Architecture

Status markers: **[built]** means implemented and tested. **[planned]** means it is a contract for a later phase and is not implemented yet.

## 1. Shape of the system

```text
 AquaKart site / PawSattva site / Spasta / internal services
        │  X-UAP-App: pk_…  (+ user ID token)      Authorization: Bearer uap_sk_…  (server-to-server)
        ▼
 ┌──────────────────────────── apps/api (Fastify) ────────────────────────────┐
 │ onRequest: request id → authenticate → request.principal                   │
 │ routes: health · auth · brands · applications · api-clients · llm          │
 │         [planned] chat · campaigns · blog-drafts · social-posts · reels ·  │
 │                   approvals · jobs                                         │
 └──────────────┬───────────────────────────────┬─────────────────────────────┘
                │                               │ enqueue (BullMQ)  [planned]
                ▼                               ▼
   packages/llm-gateway ──► OpenRouter    apps/worker (separate process)
                │                               │ agents/* (bounded workflows)
                ▼                               ▼
   MongoDB (platform DB only)            Redis (queues)     S3 (media) [planned]
                                                │
                     integrations: PawSattva Firestore · AquaKart MongoDB · Meta Graph  [planned]
```

The platform owns its own MongoDB database. By owner decision ([ADR 0002](decisions/0002-direct-writes-pawsattva-aquakart.md)) it also writes **directly** into PawSattva's Firestore (Admin SDK) and AquaKart's MongoDB (a separate least-privilege connection). Those writes are only new content in a review or draft state, plus approved changes. See [integrations/](integrations/).

## 2. Packages and dependency direction

```text
shared-types ◄── core ◄── config
      ▲           ▲
      ├── database (mongoose)
      ├── auth (jose, firebase-admin)
      └── llm-gateway (zod) ◄── integrations/openrouter
apps/api    → all of the above
apps/worker → config, core, database (more from Phase 3)
```

Rules:

- Packages never import from `apps/*`.
- `auth` does not depend on `database`. It defines structural store interfaces, and `apps/api/src/runtime.ts` wires the repositories into them. This keeps auth unit-testable without MongoDB.
- `llm-gateway` knows nothing about Mongo. Usage and budgets are injected as `UsageSink` and `BudgetGuard`.
- **The one composition root is `buildDeps()`** in `apps/api/src/runtime.ts`. Production and the integration tests both use it, so the tests exercise the real wiring.

Planned packages, each created in the phase that needs it:

| Package | Phase |
|---|---|
| `chat-engine` | 2 |
| `agent-engine` | 3 |
| `campaign-engine` | 3 |
| `automation-engine` (queues, scheduling, idempotency) | 3 |
| `media-engine` (Sharp, Remotion, FFmpeg) | 4–5 |
| `integrations/pawsattva-firebase` (Firestore Admin SDK) | 3 |
| `integrations/aquakart-mongodb` (direct, least-privilege connection to AquaKart's database) | 2–3 |
| `integrations/instagram-meta` | 4 |
| `integrations/object-storage` | 4 |
| `integrations/tts` | 5 |
| `integrations/moneyprinter` (reel render provider; **client built**) | 5 |

## 3. Identity, auth and tenant isolation **[built]**

Three kinds of caller, all resolved to a `Principal` (`packages/shared-types`) in the `onRequest` hook:

| Caller | Sends | Principal |
|---|---|---|
| Server or service | `Authorization: Bearer uap_sk_<keyId>_<secret>` | `api_client`. Brand and scopes come from the `api_clients` record. |
| Signed-in end user | `X-UAP-App: pk_…` and `Authorization: Bearer <ID token>` | `user`. The brand comes from the application record. The token is verified with that app's provider (Firebase or JWKS). The only scope is `chat:use`. |
| Anonymous end user | `X-UAP-App: pk_…` and `X-UAP-Anonymous-Id` | `anonymous`. Allowed only if the application enables it. The only scope is `chat:use`; quotas come in Phase 2. |

- **Brand-owned roles:** an application can name a `roleSource`. At sign-in, a resolver from `packages/integrations/<brand>` reads the user's role from the brand's own system and maps it to platform roles and scopes. A blocked user gets 403. A missing resolver fails closed. See [ADR 0003](decisions/0003-brand-backend-vs-agentic-layer.md); PawSattva's mapping is `pawsattva-firestore`.
- **API keys:** only `HMAC-SHA256(API_KEY_PEPPER, secret)` is stored, and checked with a timing-safe comparison. The plaintext is shown once.
- **Platform admin:** a key with `brandId = null` and `platform:admin`. It can only be minted by the CLI. A brandless key without `platform:admin` is rejected.
- **Delegation:** a caller can only create keys with scopes it already holds, and never `platform:admin`.
- **Brand edits:** brand-scoped admins may edit name, website, branding and contentFocus. `status`, `defaultModel` and `budgets` are platform-admin only.
- **Isolation is enforced twice:**
  1. Route level: `loadBrandFor()` checks the scope, then `assertBrandAccess(principal, brandId)`.
  2. Repository level: every brand-owned query filters by `brandId`. An id from another brand returns `not_found`.

  Both levels have tests (`apps/api/test/api.test.ts`, `packages/database/test/repositories.test.ts`).
- **Origin check:** `allowedOrigins` on an application is enforced when the browser sends `Origin`. The global CORS allowlist is `CORS_ALLOWED_ORIGINS`.

## 4. Brand-scoped routes: one codebase, separate URLs

Every brand gets its own URL space, and all brands share one implementation:

```text
/api/v1/brands/aquakart/...      /api/v1/brands/pawsattva/...      /api/v1/brands/spasta/...
```

Brand differences are **data**:

- brand record: branding, contentFocus, budgets, defaultModel
- application records
- assistant and agent configs
- the integration adapter chosen per brand: PawSattva drafts go to Firestore, AquaKart drafts to its MongoDB

Adding a brand means adding records, not code (spec §20.17). Planned per-brand resources:

| Resource | Endpoints [planned] | Phase |
|---|---|---|
| Campaigns | `GET/POST /brands/:b/campaigns`, `GET/PATCH /brands/:b/campaigns/:id` | 3 |
| Blog drafts | `GET/POST /brands/:b/blog-drafts`, `GET/PATCH /…/:id`, `POST /…/:id/submit` | 3 |
| Social posts (Instagram post, carousel, story) | `GET/POST /brands/:b/social-posts`, `GET/PATCH /…/:id` | 4 |
| Reels | `GET/POST /brands/:b/reels`, `GET /…/:id` (render progress) | 5 |
| Approvals | `GET /brands/:b/approvals`, `POST /…/:id/approve`, `POST /…/:id/reject` | 3 |
| Jobs | `GET /brands/:b/jobs`, `POST /…/:id/cancel`, `POST /…/:id/retry` | 3 |

## 5. LLM gateway **[built]**

`packages/llm-gateway`. It is the only path to a model.

```ts
interface LlmProvider {            // one per vendor; OpenRouter is first
  name: string;
  chat(req: ProviderRequest, signal: AbortSignal): Promise<ChatResult>;
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamEvent>; // text | tool_call | done
}
interface ChatRequest {
  route?: ModelRoute[];            // [{provider?, model}], primary then fallbacks; default from config
  messages: ChatMessage[];         // system | user | assistant(+toolCalls) | tool
  tools?: ToolDefinition[]; toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat; // text | json_object | json_schema
  temperature?; maxTokens?; timeoutMs?; signal?;
  context: { brandId; applicationId?; agentId?; sessionId?; requestId };  // from the principal
}
gateway.chat(req) · gateway.stream(req) · gateway.chatJson(req, zodSchema, name)
```

| Concern | Behaviour |
|---|---|
| Routing | `request.route`, otherwise `brand.defaultModel` (set by the API route), otherwise `DEFAULT_LLM_MODEL`. With no model configured it returns `not_configured`; it never guesses a model. |
| Retries | Exponential backoff with full jitter, honouring `Retry-After`. Applies to `rate_limited`, `provider_unavailable` and `unknown`. |
| Fallback | Moves to the next route entry when the error is fallbackable. Can cross providers. |
| Deadline / cancel | One deadline covers all retries (`AbortSignal.timeout`), combined with the caller's signal. A client disconnect aborts the upstream call. |
| Streaming | Retry and fallback only happen before the first event. A stream that fails midway is surfaced, never silently replayed. |
| Concurrency | Per-process semaphore (`LLM_MAX_CONCURRENCY`). Not distributed. |
| Usage and cost | Every attempt, successful or failed, is written to `llm_usage_logs` with the provider-reported cost (OpenRouter `usage.include`). |
| Budgets | Checked before the call against the brand's daily and monthly token and cost limits. Windows are UTC calendar day and month. One in-flight request can overshoot by its own size. |
| Errors | `LlmError` codes are mapped to client-safe `AppError`s. A provider auth failure becomes a generic upstream error, so callers learn nothing about our credentials. |

Image, audio and video providers get their own interfaces (spec §4). They do not go through `LlmProvider`.

## 6. MongoDB models

**[built]**, in `packages/database/src/models.ts`:

| Collection | Key fields and indexes | Retention |
|---|---|---|
| `brands` | `slug` unique; branding, contentFocus, defaultModel, budgets | — |
| `applications` | `brandId`; `{brandId, slug}` unique; `publishableKey` unique; auth settings (no secrets); anonymous policy | — |
| `api_clients` | `keyId` unique; `keyHash` (never selected by default); scopes, roles, status, expiresAt, lastUsedAt | — |
| `llm_usage_logs` | `{brandId, createdAt}`; tokens, `costUsd` (null when the provider does not report it), latency, status | TTL 400 days |
| `audit_logs` | `{brandId, createdAt}`; actor, action, target, metadata (no PII) | TTL 730 days |

**[planned]**. Every brand-owned document carries `brandId`, and `applicationId` where relevant:

| Phase | Collections |
|---|---|
| 2 | `assistant_configs`, `chat_sessions`, `chat_messages` (paginated by `{sessionId, createdAt}`; TTL policy for anonymous sessions), `knowledge_documents`, `knowledge_chunks` |
| 3 | `agent_configs` (versioned), `campaigns`, `content_briefs`, `blog_drafts`, `approval_requests`, `automation_jobs`, `publishing_records` (unique idempotency key) |
| 4–5 | `social_posts`, `reels`, `media_assets` (metadata only; files live in S3) |
| 6 | `system_settings` |

## 7. Chat API contract **[planned, Phase 2]**

These are the endpoints from spec §5. The brand and user always come from the principal (`X-UAP-App` plus a token, or anonymous).

| Endpoint | Body / query | Notes |
|---|---|---|
| `POST /api/v1/chat/sessions` | `{ assistant?: string }` | The assistant config is resolved per application; a client cannot pick another brand's assistant. |
| `GET /api/v1/chat/sessions` | `?cursor&limit` | Only the caller's own sessions. |
| `GET /api/v1/chat/sessions/:id/messages` | `?cursor&limit` | Checks ownership. |
| `POST /api/v1/chat/completions` | `{ sessionId, message }` | Non-streaming. |
| `POST /api/v1/chat/stream` | `{ sessionId, message }` | SSE events: `delta`, `tool`, `product_cards`, `done`, `error`. Client disconnect cancels the call. |
| `DELETE /api/v1/chat/sessions/:id` | — | Checks ownership. |

- **Tools** come from the assistant config allowlist and are executed by the chat engine with authorization checks. They are bounded by a maximum iteration count.
- **AquaKart tools** read the products collection with `dpPrice` always projected out.
- **Quotas:** per principal and per application, with anonymous limits from `applications.anonymous`.

## 8. Agent contract **[planned, Phase 3]**

See [../agents/README.md](../agents/README.md). Agents run in the worker as BullMQ jobs and are bounded typed workflows. Content they produce enters the approval state machine (spec §12) at `GENERATED`.

## 9. Configuration

`packages/config` validates the environment at startup and fails fast with a list of every problem. See `.env.example` for all variables.

- **Optional integration groups are all-or-nothing:** `openrouter`, `firebase`, `aquakartMongo`, `meta`, `s3`.
  - A partial group is an error.
  - A missing group means the integration is disabled, and readiness reports `false`.
- **Staging and production** forbid `*` in CORS and debug/trace logging.

## 10. Operations

- **Request ids:** the `X-Request-Id` header is accepted if it is safe (8–128 chars of `[A-Za-z0-9._-]`), otherwise one is generated. It is echoed back and put in every log line and error body.
- **Logging:** pino JSON. Authorization headers, cookies, tokens, keys and passwords are redacted.
- **Health:** `/health/live` is a process check. `/health/ready` checks MongoDB and Redis (2 s timeout each) and returns 503 when degraded. It reports integration status as booleans only.
- **Shutdown:** on SIGTERM/SIGINT the API closes Fastify (draining in-flight requests), then Redis, then MongoDB, and is forced after 15 s. The worker waits for active jobs.
  - Not verified on Windows, where SIGTERM kills the process immediately. Verify in the Linux container.
- **MongoDB recovery:** the initial connect retries with backoff (10 attempts). After that, driver reconnection is logged.
