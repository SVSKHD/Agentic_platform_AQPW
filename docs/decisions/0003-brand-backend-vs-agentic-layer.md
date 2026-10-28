# ADR 0003: Brand backends own operations; the platform owns the agentic layer

Date: 2026-10-25. Status: accepted (owner decision).

## Decision

Each brand keeps its own backend. The platform is only the **agentic layer** on top of it.

| Owned by the brand (PawSattva today) | Owned by the platform |
|---|---|
| Users, sign-up, profiles | Paw GPT chat engine and assistant config |
| **Roles** (`admin`, `author`, `user`), blacklist, restricted emails | AI usage limits enforcement, rate limiting |
| Admin panel, blog editing and **publishing** | AI blog drafts, SEO suggestions (written in review state) |
| Payments, Daily Pass and Plus granting | Chat history (`users/{uid}/pawGptChats`) |
| Pet logger, pet profiles, vet hospitals, walks | LLM gateway, cost tracking, agent jobs |
| Account deletion (including a recursive delete of the user's subcollections) | Deleting a user's chats on request |

## Roles are read, never managed

- The platform reads a brand user's role at sign-in through a **role resolver**: `auth.roleSource` on the application record, implemented in `packages/integrations/<brand>`.
- It never writes `admin`, `role` or `blacklisted`.
- If an app names a role source the server has not configured, sign-in fails (`not_configured`) instead of falling back to plain-user access.

PawSattva (`pawsattva-firestore`), from `users/{uid}` and `restrictedEmails/{email}`:

| PawSattva | Platform role | Scopes |
|---|---|---|
| user (`admin != true`) | `end_user` | `chat:use` |
| author (`admin == true`, `role == "author"`) | `editor` | `chat:use`, `content:read`, `content:write` |
| admin (`admin == true`, any other role, including missing) | `reviewer` | adds `content:review` |
| `blacklisted == true` or a restricted email | blocked (403) | — |
| no profile | rejected (401) | — |

- **Brand users never get platform administration** (`platform:admin`, `api_clients:write`, `brands:write`).
- **`content:publish` is not granted either.** Publishing stays in PawSattva's admin.

## Consequences

- Quota exemption for staff (PawSattva admins and authors are uncapped) follows from these roles in the Phase 2 chat engine.
- A new brand with its own roles needs a resolver in its integration package and a `roleSource` value, not changes to shared auth code.
- The resolver is unit-tested against PawSattva-shaped documents. It has **not** run against the real PawSattva project, because no service account is available yet.
