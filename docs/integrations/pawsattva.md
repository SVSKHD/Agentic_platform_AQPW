# PawSattva integration contract

Source: a read-only inspection of the PawSattva repo (Next.js 16 App Router, Firebase) on 2026-10-25. File references are relative to that repo. **Nothing in PawSattva was modified.**

## Decision (owner, 2026-10-25): write directly to Firestore, in the review state

The platform writes to PawSattva's Firestore through the **Firebase Admin SDK** (`FIREBASE_*` service account). This supersedes the earlier plan to call PawSattva's draft API. See [ADR 0002](../decisions/0002-direct-writes-pawsattva-aquakart.md).

### New blog drafts

- **Where:** a transaction create in `blogs`, with `status: "pending_review"`.
- **Reviewed in:** PawSattva's existing `/admin` Review tab. An admin approves through `approveBlog`, which sets `published`.
- **Document shape:** mirror PawSattva's own AI draft route field for field (`app/api/integrations/ai/blog-drafts/route.ts:59-84`):
  - `title`, `slug`, `excerpt`, `image`, `content` (HTML)
  - `keywords` (comma-separated string)
  - `seo{title, description, keywords[], canonicalUrl, robots, image, og*, twitter*}`
  - `categoryId`, `categoryIds[]`, `authorName`
  - `status: "pending_review"`, `source`
  - counters at 0
  - `reviewRequestedAt`, `date`, `createdAt`, `updatedAt` as serverTimestamps
- **Idempotency:** the same rule PawSattva uses. The doc id is `ai-<sha256(lowercased title)[0:32]>`, created in a transaction. If the doc exists, it is returned unchanged. On a slug clash, append `-<6 hex>`.
- **Slug rule:** lowercase, strip `[^\w\s-]`, collapse `[\s_-]+` to `-`, trim dashes.
- **Write guard:** the adapter may only create new docs with `pending_review`. It must **never** set `status: "published"` and never edit a published post's live fields.

### Why the platform enforces this

The Admin SDK bypasses `firestore.rules`. A service account's IAM role cannot be limited to one collection. So the write rules above live in our adapter code and its tests. A leaked service account key would give full Firestore access. Keep the key in a secret manager, separately per environment.

### Existing issue that now matters more

PawSattva renders and serves `pending_review` posts publicly (see below). AI drafts written for review will be **publicly readable before review** until PawSattva fixes `/blog/[slug]` and the `blogs` read rule.

## Boundary (owner decision, 2026-10-25)

PawSattva keeps its backend and all non-AI operations:

- users and roles
- admin panel and publishing
- payments, Daily Pass and Plus
- pet logger
- **account deletion**, including a recursive delete of the user's subcollections

The platform is the agentic layer only: Paw GPT, AI drafts, SEO suggestions, chat history and AI limits.

**Roles:** the platform reads PawSattva roles at sign-in (`roleSource: "pawsattva-firestore"`, `packages/integrations/pawsattva-firebase`) and never changes them. The mapping table is in [ADR 0003](../decisions/0003-brand-backend-vs-agentic-layer.md).

## Paw GPT today (what Phase 2 must preserve)

Source: `lib/paw-gpt.ts`, `app/api/paw-gpt/route.ts`, `lib/server/paw-gpt-*.ts`, `firebase/firestore.rules:74-242`, and `app/(chat)/paw-gpt/paw-gpt-client.tsx`.

### Limits

| Who | Questions | Tokens | Enforced by |
|---|---|---|---|
| Guest (not signed in) | **3 in total**, ever, per browser cookie. Plus **15 per day per IP** (hashed) to stop cookie clearing. | No limit (counted only) | Server, Admin SDK, `pawGptGuests` and `pawGptGuestIps` |
| Signed-in pet parent (free) | **5 per day** (India calendar day) | **100,000 per day**, checked before each question | Firestore rules on `users/{uid}/pawGptUsage/{YYYY-M-D}`, written with the user's own token |
| Daily Pass (₹29) | Unlimited that day | Up to `passTokenLimit` (300,000) | `passTokenLimit` on the day's usage doc. Set only by the server (`grantDailyPass`), idempotent per payment. |
| Paw GPT Plus (₹300 / 30 days) | Unlimited | 300,000 per day | `pawGptSubscriptions/{uid}.activeUntil` (`grantSubscription`) |
| Admins and authors (`users/{uid}.admin`) | Unlimited | Unlimited | Counted, never capped |
| Everyone | — | — | **25 requests per 10 min** per uid or guest IP, kept **in memory per instance** (resets on cold start; not shared across instances) |

Request limits: up to 40 messages, 4,000 chars per message, 60,000 chars of pet context, 60 days of meal logs, 180 days of weights. Guests never get a pet record; the server strips it.

### Auth

The server decodes the Firebase ID token, then reads `users/{uid}` **through the Firestore REST API with the user's own token**. That read is what proves the token is valid, because rules make profiles owner-only. Then:

- `blacklisted` blocks the user (403).
- So does a doc at `restrictedEmails/{email}` (403).
- `admin == true` exempts the user from limits.

### History

- History lives **only in the browser** (`localStorage`, key `paw-gpt-chats:<uid>`, or `:guest` for visitors).
- Up to 30 conversations, 40 messages each.
- It is not synced across devices, is lost when browser data is cleared, and is never stored in Firestore.
- Each request carries the conversation so far, so the server keeps no state.

### Firestore documents involved

| Path | Writer | Purpose |
|---|---|---|
| `users/{uid}` | user | Profile, `admin`/`role`, `blacklisted` |
| `restrictedEmails/{email}` | admin | Blocked emails |
| `users/{uid}/pawGptUsage/{YYYY-M-D}` | user token (rules-checked) or server | `count`, `tokens`, `inputTokens`, `outputTokens`, `passTokenLimit`, `updatedAt`. Read by the UI usage meter and by Admin › Analytics (collection-group query). |
| `pawGptSubscriptions/{uid}` | server only | `plan`, `activeUntil` |
| `pawGptPassGrants/*`, `pawGptSubscriptionGrants/*` | server only | Idempotency per payment |
| `pawGptGuests/{sha256(id)}`, `pawGptGuestIps/{day}_{sha256(ip)}` | server only | Guest counters |

### Plan for the platform (Phase 2)

- **Firestore stays the source of truth for PawSattva quotas.** The platform reads and writes the same documents, so the UI meter, admin analytics, Daily Pass and Plus keep working unchanged.
- **The Admin SDK bypasses rules, so the platform must enforce the limits itself:**
  - the 5-question, 100k, pass and Plus rules
  - atomically, in one Firestore transaction (check and increment together)
  - with tests that pin the numbers to `lib/paw-gpt.ts`
- **Token verification** uses the Admin SDK `verifyIdToken`, followed by the `blacklisted` and `restrictedEmails` checks.
- **Rate limiting** moves to Redis (shared across instances), replacing the in-memory per-instance limiter.
- **Veterinary escalation** and the system prompt carry over from `/api/paw-gpt` into the Paw GPT assistant config.
- **Chat history lives in Firestore** (owner decision, 2026-10-25); design below.
- **Known weaknesses to fix in the move:**
  - The guest IP hash salt falls back to a constant when `PAW_GPT_GUEST_SALT` is unset.
  - The token limit is checked before a question, so one long answer can overshoot it.

### Chat history in Firestore (owner decision, 2026-10-25)

The layout follows PawSattva's existing per-user subcollections (`petLoggerEntries`, `pawGptUsage`) and its client types (`Conversation`, `ChatItem` in `app/(chat)/paw-gpt/components/chat-message.tsx`):

```text
users/{uid}/pawGptChats/{chatId}
  petName, title, messageCount, createdAt, updatedAt, source: "uap"
users/{uid}/pawGptChats/{chatId}/messages/{messageId}
  role: "user" | "assistant", content, createdAt, inputTokens?, outputTokens?
```

- **Messages are a subcollection, not an array.** Firestore documents are capped at 1 MB, long answers add up, and the spec requires paginated history.
- **Only the platform writes** (Admin SDK). It saves finished turns only, as the current client does, so a half-streamed answer is never stored. Browsers can **read and delete** their own chats but never write, so a user cannot forge assistant messages.
- **Retention** keeps today's limits: the newest 30 conversations, with 40 messages each sent as model context. Older conversations are trimmed by the platform.
- **Guests** keep browser-only history (`paw-gpt-chats:guest`). On sign-in, the client sends those chats to the platform's import endpoint once. They are stored marked `imported: true`.
- **Existing `localStorage` chats** of signed-in users are imported the same way, once.

**Rules to add to PawSattva's `firebase/firestore.rules`.** This is a PawSattva change, and the owner deploys it. It goes inside `match /users/{userId}`:

```text
match /pawGptChats/{chatId} {
  allow read, delete: if isOwner(userId);
  allow create, update: if false;          // written only by the platform (Admin SDK)
  match /messages/{messageId} {
    allow read, delete: if isOwner(userId);
    allow create, update: if false;
  }
}
```

### What the platform may touch in PawSattva's Firestore

The Admin SDK can reach the whole database, so this allowlist is enforced in the adapter code, with a test that refuses any other path.

| Path | Access | Why |
|---|---|---|
| `users/{uid}` | read | Profile, `admin`, `role`, `blacklisted` |
| `restrictedEmails/{email}` | read | Block check |
| `pawGptSubscriptions/{uid}` | read | Plus status |
| `users/{uid}/pawGptUsage/{day}` | read + transactional update | Quotas |
| `pawGptGuests/*`, `pawGptGuestIps/*` | read + transactional update | Guest quotas |
| `users/{uid}/pawGptChats/**` | read, write, delete | History |
| `users/{uid}/petLoggerEntries`, `users/{uid}/petWeightEntries`, `petFeeds` (where `userId == uid`) | read | Pet context |
| `blogs` (published only), `categories` | read | Recommendations ("quick reads") |
| `blogs` | create only, `status: "pending_review"` | AI drafts |
| everything else | **none** | |

`uid` always comes from the verified ID token, never from the request body.

### Pet context: read on the server

- **Today:** the browser builds the pet record (`buildPetContext` in `components/pet-data.ts`) and sends up to 60k characters with every question. The server trusts it.
- **Platform:** it reads the signed-in user's own `petFeeds`, meal logs (60 days) and weights (180 days) by verified `uid`.
  - It applies the same `PAW_GPT_LIMITS`.
  - Requests become small, and the record cannot be tampered with.
  - Guests still get no pet record.

### Found during the scan

- **Account deletion leaves personal data behind.**
  - `deleteUser` (`firebase/firestore.ts:382`) deletes only `users/{uid}`. Firestore does not cascade, so `pawGptUsage`, `petLoggerEntries`, `petWeightEntries` and, from now on, `pawGptChats` are orphaned.
  - **Owner decision: PawSattva owns account deletion.** It should run a recursive delete (Admin SDK `recursiveDelete` on `users/{uid}`) instead of `deleteDoc`. This is a PawSattva change, not made by this repo.
  - The platform separately offers "delete all my chats".
- **The browser-only Firebase AI path bypasses the platform.** `NEXT_PUBLIC_PAW_GPT_PROVIDER=firebase-ai` answers from the browser and writes usage itself. Once Paw GPT moves to the platform, it must be set to `server` (or removed), or questions skip platform limits, history and logging.
- **Client protocol change.**
  - Today the client reads a plain-text stream plus the `X-Paw-Gpt-Guest-Remaining` header from `/api/paw-gpt`. The platform streams SSE (spec §5).
  - Either the Paw GPT client is updated to call the platform directly (`X-UAP-App` plus the Firebase ID token), or `/api/paw-gpt` becomes a thin server-to-server proxy. A proxy keeps the client unchanged, but it must forward the visitor's IP for guest limits.

## Schema facts (`blogs`, `firebase/firestore.ts:50-82`)

- **Content and taxonomy:**
  - `content` is HTML (TipTap).
  - `keywords` is a comma-separated **string**.
  - `seo.keywords` is a `string[]`.
  - `categoryIds: string[]` holds `categories` doc ids. `categoryId` is the legacy first category.
- **Status:** `draft | pending_review | published`.
- **Timestamps:** `date`, `createdAt` and `updatedAt` are serverTimestamps. Older documents may hold mixed timestamp types.
- **Images:** Firebase Storage URLs.
  - The admin form only accepts these hosts: `**.unsplash.com`, `lh3.googleusercontent.com`, `firebasestorage.googleapis.com`, `i.pravatar.cc`, `media.istockphoto.com`, `**.pinimg.com`.
  - **Our featured images must use an allowed host.** Otherwise the draft fails validation when an admin edits it.
- **Instagram fields on a blog:** `instagramAutoPost`, `instagramCaption`, `instagramPostId`, `instagramPostStatus`, `instagramPostError`.

## Admin identity

- Admins are identified by `users/{uid}`: `admin == true`, not blacklisted, and `role != "author"` for full admins. Custom claims are not used.
- Server-side reference: `lib/server/staff-auth.ts` (`verifyStaff`).

## Open questions for the owner

1. **Where do SEO refresh suggestions go?**
   - A published post cannot be put back to `pending_review`, because that unpublishes it.
   - Writing `seo.*` directly changes the live page.
   - A non-live place is needed, for example a `seoSuggestion` map on the blog doc with its own status. PawSattva's admin UI does not show such a field yet. See docs/phases.md (Phase 3).
2. Should AI drafts get a default category? `categoryIds` is empty, and the admin form requires a category before publishing.
3. Featured images must be on an allowed host (`firebasestorage.googleapis.com` and others). Do we upload to PawSattva's Firebase Storage? `storage.rules` is not in the repo.
4. Paw GPT runs inside PawSattva today (`/api/paw-gpt`) with its own quotas in `users/{uid}/pawGptUsage`. Does the platform replace it, or run alongside it?
5. Instagram: PawSattva publishes through an unauthenticated `/api/instagram/publish`. Phase 4 should replace that.

## Security issues found in PawSattva (not fixed; owner to decide)

- `POST /api/instagram/publish` has **no authentication**. Anyone who finds it can post to the Instagram account.
- `blogs` is publicly readable through the SDK (`allow read: if true`), and `/blog/[slug]` renders **draft and pending_review** posts to anyone who knows the slug. AI drafts are therefore publicly readable before review.
- The AI draft route does not validate `image` hosts.
