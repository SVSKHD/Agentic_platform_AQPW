# API (implemented endpoints)

The live OpenAPI document is served at `/docs` (UI) and `/docs/json`. This page covers the conventions that the OpenAPI document does not.

## Authentication

| Header | Used by |
|---|---|
| `Authorization: Bearer uap_sk_…` | Servers and services (API keys) |
| `X-UAP-App: pk_…` | Frontends: identifies the application, and through it the brand |
| `Authorization: Bearer <Firebase ID token or JWT>` | End users, together with `X-UAP-App` |
| `X-UAP-Anonymous-Id: <16–64 url-safe chars>` | Anonymous end users, when the app allows it |
| `X-Request-Id` | Optional. Echoed back on every response. |

Get the first key with the CLI: `pnpm api-client:create --name ops --platform`. Use that key to create brand-scoped keys over the API.

### Scopes

`platform:admin` implies every scope, and only for API clients.

| Scope | Allows |
|---|---|
| `brands:read` / `brands:write` | View and edit the caller's own brand. Budgets, status and defaultModel are platform-admin only. |
| `applications:read` / `applications:write` | Manage the brand's applications |
| `api_clients:write` | List, create and revoke the brand's API keys (only with scopes the caller holds) |
| `llm:invoke` | `POST /api/v1/llm/completions` |
| `chat:use` | End-user chat (Phase 2) |
| `content:read`, `content:write`, `content:review`, `content:publish`, `jobs:manage` | Reserved for Phases 3–4 |

## Errors

Every error has the same shape:

```json
{ "error": { "code": "forbidden", "message": "You do not have access to this brand", "requestId": "…", "details": {} } }
```

| Status | `code` |
|---|---|
| 400 | `validation_failed`, `bad_request` |
| 401 | `unauthenticated` |
| 402 | `budget_exceeded` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict` |
| 429 | `rate_limited` |
| 500 | `internal` |
| 501 | `not_implemented` |
| 502 | `upstream_error` |
| 503 | `not_configured` |

## Endpoints

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/health/live` | none | Process is up |
| GET | `/health/ready` | none | MongoDB and Redis checks. 503 when degraded. Integration flags are booleans only. |
| GET | `/api/v1/auth/me` | any principal | The principal as the server sees it |
| GET | `/api/v1/brands` | `brands:read` | Platform admin sees all brands; everyone else sees only their own |
| POST | `/api/v1/brands` | `platform:admin` | |
| GET / PATCH | `/api/v1/brands/:brandSlug` | `brands:read` / `brands:write` | |
| GET / POST | `/api/v1/brands/:brandSlug/applications` | `applications:read` / `:write` | Returns `publishableKey` |
| GET / PATCH | `/api/v1/brands/:brandSlug/applications/:applicationId` | `applications:read` / `:write` | |
| GET / POST | `/api/v1/brands/:brandSlug/api-clients` | `api_clients:write` | POST returns `apiKey` **once** |
| POST | `/api/v1/brands/:brandSlug/api-clients/:clientId/revoke` | `api_clients:write` | Takes effect immediately |
| POST | `/api/v1/llm/completions` | `llm:invoke` (brand key) | Model from `brand.defaultModel` or `DEFAULT_LLM_MODEL`. Usage is billed to the caller's brand. |

Planned endpoints (chat, campaigns, drafts, social, reels, approvals) are in [architecture.md](architecture.md) §4 and §7.
