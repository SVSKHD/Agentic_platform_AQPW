# ADR 0001: Phase 1 foundations

Date: 2026-10-25. Status: accepted.

## 1. Fastify replaces the initial Express scaffold

The first scaffold in this repo used Express. The master spec mandates Fastify, so the scaffold was removed before any data or clients depended on it.

## 2. Workspace packages export TypeScript source; apps are bundled

- `@uap/*` packages point `exports` at `src/index.ts`. tsx (dev), Vitest and `tsc --noEmit` consume them directly, with no per-package build step.
- `apps/*` are bundled with tsup, which inlines `@uap/*` and keeps npm packages external.

**Consequence:** every npm package an app uses at runtime must be listed in that app's `package.json`. pnpm does not hoist transitive dependencies, and the bundle cannot resolve them otherwise.

## 3. Brands are data, routes are brand-scoped

The owner asked for separate routes for AquaKart, PawSattva and Spasta. They are separate URL spaces, `/api/v1/brands/:brandSlug/...`, all served by one implementation. Per-brand behaviour lives in records and integration adapters. This satisfies spec §20.17 (no logic duplicated across brands) and makes onboarding a brand a data change, not a code change.

## 4. Integrate through existing APIs, not their databases (superseded)

**Superseded by [ADR 0002](0002-direct-writes-pawsattva-aquakart.md).** The owner chose direct writes to PawSattva's Firestore and AquaKart's MongoDB.

The original plan was PawSattva's `POST /api/integrations/ai/blog-drafts` and AquaKart's `/v1` HTTP API.

## 5. API keys use HMAC with a pepper

Keys are `uap_sk_<keyId>_<secret>`. Only `HMAC-SHA256(API_KEY_PEPPER, secret)` is stored. A database leak alone does not let anyone verify or forge keys. The trade-off is that rotating the pepper invalidates every key.

## 6. Cost comes from the provider

The gateway records `usage.cost` as reported by OpenRouter, and stores `null` when it is absent. There is no price table in the code (spec §20.12). Budgets therefore depend on the provider reporting cost; token budgets work regardless.
