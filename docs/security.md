# Security model and risks

## In place (Phase 1, tested)

- **API keys:** HMAC-SHA256 with a server-side pepper, timing-safe comparison, shown once, expiry, revocation that takes effect immediately, and `lastUsedAt`.
- **Tenant isolation:** enforced at both the route and the repository layer. A brand is never taken from client input. Cross-brand access tests cover every brand route.
- **Privilege limits:**
  - Delegated keys get only the delegator's scopes.
  - `platform:admin` can only be created through the CLI.
  - Budget, routing and status changes are platform-admin only.
- **End-user tokens** are verified per application (Firebase or JWKS). End users only ever get `chat:use`.
- **CORS:** global allowlist, plus a per-application origin allowlist. Wildcard is rejected outside development.
- **Data exposure:**
  - Response schemas are allowlists, so `keyHash` and other internal fields cannot be serialized.
  - Readiness exposes integration booleans only.
  - Provider auth errors are hidden from callers.
- **Logs:** pino redacts authorization headers, cookies, tokens, keys and passwords. Audit metadata excludes PII.
- **Request limits:** 1 MB body limit. Zod validation on every body and params.

## Not yet in place

| Risk | Plan | Phase |
|---|---|---|
| No HTTP rate limiting | Per-principal limits backed by Redis (`@fastify/rate-limit`). The LLM budget guard limits spend only, not request rate. | 2 |
| Prompt injection in chat and agents | Separate system and user content; tool allowlists and authorization per call; never execute model-chosen URLs. Treat retrieved content as data. | 2–3 |
| Moderating model output | Policy checks before content reaches users or the approval queue | 2–3 |
| SSRF from media URLs and fetch tools | A single egress helper: allowlisted hosts, private IP ranges blocked, size and time limits | 3–4 |
| Webhook signatures (Meta) | Verify `X-Hub-Signature-256` with the app secret | 4 |
| Media upload validation | MIME sniffing, size limits, image re-encoding via Sharp | 4 |
| Direct writes to AquaKart MongoDB and PawSattva Firestore | Dedicated AquaKart Mongo user with collection-level privileges; write guards and schema re-validation in each adapter, with tests (ADR 0002) | 2–3 |
| Pepper rotation | Rotating `API_KEY_PEPPER` invalidates every key. Dual-pepper verification if rotation is needed. | 6 |
| Secret management | Env vars today. Use a secret manager (Doppler is already used by AquaKart) per environment. | 6 |
| In-process concurrency only | The LLM semaphore is per process. A global cap needs Redis. | 6 |

## Risks in the existing apps

These were found during contract discovery and are **not changed by this repo**. They need the owner's decision.

**PawSattva:**

- `/api/instagram/publish` is unauthenticated.
- Draft blogs are publicly readable and render publicly.

Details in [integrations/pawsattva.md](integrations/pawsattva.md).

**AquaKart:**

- Several public endpoints leak `dpPrice`.
- Draft blogs and orders are readable without auth.
- Hardcoded fallback API keys exist in the WhatsApp utilities.
- Writes through its API need a full-admin JWT. This is no longer used: the platform writes to MongoDB directly (ADR 0002).

Details in [integrations/aquakart.md](integrations/aquakart.md).

## Deployment risks

- The Docker image and Compose stack are written but **were not built or run**, because Docker was not available on the development machine. The production install (`pnpm deploy`) and the bundles were run outside Docker.
- Graceful shutdown is implemented but was not verifiable on Windows. Verify it in the Linux container.
- Redis must run with `maxmemory-policy noeviction` (set in `docker-compose.yml`), or BullMQ can lose jobs.
- MongoDB credentials should be scoped to the platform database only (`readWrite` on that database).
