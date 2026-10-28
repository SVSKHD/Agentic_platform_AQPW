# AGENTS.md — rules for anyone changing this repo (humans and AI agents)

This file is the entry point. Read it fully before making any change.

## 1. Read before you change anything

Read in this order. Do not skip steps 1–3.

1. [docs/spec/master-spec.md](docs/spec/master-spec.md): the scope. It is the source of truth and lists the owner's amendments at the top.
2. [docs/phases.md](docs/phases.md): what is built, what is verified, and what is not done yet.
3. [docs/architecture.md](docs/architecture.md): packages, request flow, tenant isolation, LLM gateway, and the planned contracts.
4. The doc for the area you are touching:
   - [docs/api.md](docs/api.md)
   - [docs/security.md](docs/security.md)
   - [docs/integrations/pawsattva.md](docs/integrations/pawsattva.md)
   - [docs/integrations/aquakart.md](docs/integrations/aquakart.md)
   - [agents/README.md](agents/README.md)
5. [docs/decisions/](docs/decisions/): why things are the way they are. If you are about to undo a decision, read its ADR first.

## 2. Non-negotiable rules

These come from the spec, and the code depends on them.

1. **Tenant isolation lives in the server.**
   - The brand always comes from the authenticated principal (`request.principal`).
   - Never take it from the body, a query string, or a header the client controls.
   - Every repository method for data a brand owns takes `brandId` and puts it in the query filter.
   - Every `/brands/:brandSlug/*` handler goes through `loadBrandFor()` (`apps/api/src/routes/brand-access.ts`).
2. **Every LLM call goes through `LlmGateway`.**
   - Never call OpenRouter or any provider directly from an agent, a route, or a worker.
3. **No hardcoded model ids, prices, or secrets.**
   - Models come from configuration: `DEFAULT_LLM_MODEL`, `brand.defaultModel`, or per-agent config.
   - Cost is what the provider reports. It is never estimated from a hardcoded price table.
4. **Secrets never go into MongoDB, logs, API responses, or the browser.**
   - API keys are stored as an HMAC hash only.
   - An application record may name an env var; it never holds the secret value.
5. **Writes to the existing systems are tightly limited** ([ADR 0002](docs/decisions/0002-direct-writes-pawsattva-aquakart.md)).
   - The platform writes directly to PawSattva's Firestore and AquaKart's MongoDB. It may only:
     - create **new** content in the review or draft state (`pending_review` for PawSattva, `draft` for AquaKart)
     - apply changes that a reviewer has approved
   - Never set content to published, never delete, and never change live fields without approval.
   - Never write to orders, payments, users, products, or inventory.
   - Each adapter re-applies the target app's own validation, because its rules and Mongoose validation do not run on our writes. Tests must pin those rules.
6. **Draft first, approval first.**
   - Generated content is never published without the approval workflow (Phase 3).
7. **No fake integrations.**
   - If a credential or contract is missing, implement the typed interface, return `not_configured` or `not_implemented`, and document what is needed.
   - Never return mock data from production code.
8. **Never report something as done unless it was tested.**
   - Update [docs/phases.md](docs/phases.md) honestly: built, verified, or not verified.

## 3. Conventions

- **TypeScript:** strict, ESM, `nodenext`. Relative imports use `.js` extensions. Avoid `any`.
- **Workspace packages** (`@uap/*`) export TypeScript source. Apps bundle them with tsup.
  - Every npm package an app needs at runtime must be a direct dependency of that app.
  - Bundles keep npm packages external, and pnpm does not hoist transitive dependencies.
- **Validation:** Zod at every boundary (env, HTTP body/params, LLM structured output).
- **Errors:** throw `AppError` (`@uap/core`) or `LlmError` (`@uap/llm-gateway`). The API error handler turns them into `{ error: { code, message, details?, requestId } }`.
- **Responses:** every route declares a Zod response schema. The serializer drops fields that are not in the schema, so internal fields cannot leak.
- **Audit:** every write by an authenticated actor records an `audit_logs` entry. Keep PII out of `metadata`.
- **Mongoose updates:** use `returnDocument: "after"`, not the deprecated `new: true`.
- **Style:** match the surrounding code. Keep comments rare; write them only for the "why".
- **Abstractions:** add one only when a second real use exists.

## 4. Where things go

| You are adding… | Put it in |
|---|---|
| An HTTP route | `apps/api/src/routes/` (register it in `server.ts`) |
| Business logic shared by routes and workers | a `packages/*-engine` package (create it in the phase that needs it) |
| A MongoDB collection | `packages/database/src/models.ts` and a tenant-scoped repository in `repositories.ts` |
| A call to an external system | `packages/integrations/<name>/`, behind a typed interface |
| An LLM provider | `packages/integrations/<name>/`, implementing `LlmProvider` |
| A background job | `apps/worker/` (the queue lives in `automation-engine` from Phase 3) |
| An AI agent | `agents/<name>/` (see [agents/README.md](agents/README.md)) |
| An env var | `packages/config/src/index.ts` and `.env.example`; also `docs/architecture.md` if it is an integration group |

Never put brand-specific code paths (`if brand === "aquakart"`) in shared code. Brand differences belong in data (brand and application records, assistant and agent configs) or in an integration adapter.

## 5. Before you finish a change

```bash
pnpm typecheck   # must be clean
pnpm test        # must pass; add tests for new behaviour, including a tenant-isolation test for any brand-owned data
pnpm build       # bundles must build
```

Then:

- Update [docs/phases.md](docs/phases.md) if the status of a phase changed.
- Update [docs/api.md](docs/api.md) if you changed an endpoint.
- Add an ADR in [docs/decisions/](docs/decisions/) if you made an architectural choice.
- Report what you verified and what you did not. Do not claim more than the tests show.
