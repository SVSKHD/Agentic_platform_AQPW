# AquaKart integration contract

Source: a read-only inspection of AQUAKARTBACKEND (Express 5, Mongoose) on 2026-10-25. File references are relative to that repo. **Nothing in AquaKart was modified.**

## Decision (owner, 2026-10-25): use AquaKart's MongoDB directly

The platform connects to AquaKart's MongoDB (`AQUAKART_MONGODB_URI`). This supersedes the earlier HTTP-API plan. See [ADR 0002](../decisions/0002-direct-writes-pawsattva-aquakart.md). The connection is separate from the platform database; config refuses to start if they are the same.

### Least-privilege database user (required before going live)

Create a dedicated MongoDB user with a custom role. **Never reuse AquaKart's app credentials (`DB_URL`).**

| Collection | Model (`src/models/…`) | Privileges |
|---|---|---|
| `aquaproducts` | `AquaProduct` (`product.js`) | `find` |
| `aquacategories` | `AquaCategory` (`category.js`) | `find` |
| `aquasubcategories` | `AquaSubCategory` (`sub-category.js`) | `find` |
| `aquablogs` | `AquaBlog` (`blog.js`) | `find`, `insert`, `update` |
| `aquaseos` | `AquaSeo` (`seo.js`) | `find`, `insert`, `update` |
| everything else (`aquaorders`, `aquaecomusers`, `aquaadminusers`, payments, CRM, coupons, …) | | **none** |

**Collection names confirmed** (2026-10-25). No AquaKart model sets an explicit `collection:`, and nothing overrides pluralization. The names above are the output of Mongoose 9's own `pluralize()` on the model names, and AquaKart also runs Mongoose 9. `pnpm inspect:aquakart` (read-only) can confirm them against Atlas.

Example Atlas custom role (Database Access, then Custom Roles). Replace `<db>` with AquaKart's database name:

```json
[
  { "resource": { "db": "<db>", "collection": "aquaproducts" },      "actions": ["find"] },
  { "resource": { "db": "<db>", "collection": "aquacategories" },    "actions": ["find"] },
  { "resource": { "db": "<db>", "collection": "aquasubcategories" }, "actions": ["find"] },
  { "resource": { "db": "<db>", "collection": "aquablogs" },         "actions": ["find", "insert", "update"] },
  { "resource": { "db": "<db>", "collection": "aquaseos" },          "actions": ["find", "insert", "update"] }
]
```

### Reads: catalog for the shopping assistant (Phase 2)

- Read from the products collection with a **projection that always excludes `dpPrice`** (dealer price). The adapter enforces this and a test asserts it.
- Fields used:
  - name and identity: `title`, `ShortName`, `slug`/`seoSlug`, `code`, `brand`
  - pricing: `price`, `discountPriceStatus`, `discountPrice`, `discountPricePercentage`
  - stock: `stock`
  - media and taxonomy: `photos[].secure_url`, `category`, `subCategory`
  - reviews: `ratings`, `numberOfReviews`
- Specs live inside the `description` HTML; there are no structured specs.

### Writes: blog drafts (Phase 3)

- **Insert:** a new `AquaBlog` document with `status: "draft"` and `generatedBy: "ai"`.
- **Reviewed in:** AquaKart's admin, which lists drafts through `GET /v1/all-blogs?status=draft`.
- **Raw driver writes bypass AquaKart's Mongoose validation.** The adapter must re-apply its rules:

  | Field | Rule |
  |---|---|
  | `title` | Required, ≤120 |
  | `description` | Required; HTML |
  | `brand` | **Required** |
  | `shortDescription` | ≤320 |
  | `notes` | ≤300 |
  | `keywords` | Comma-separated string |
  | `keyphrases` | String |
  | `keyHighlights`, `tags` | `string[]` |
  | `titleImages`, `photos` | `[{id, secure_url}]` |
  | `category`, `subCategory` | ObjectIds; the subcategory must belong to the category |
  | `createdAt` | Set at write time |

- **Slugs:** AquaKart does not enforce unique slugs, so the adapter checks uniqueness before inserting. It uses the same approach as AquaKart's `uniqueSlug` in `jobs/aiBlogDrafts.js`.
- **Write guard:** the adapter only inserts drafts. It never sets `status: "published"` and never edits a published post's live fields.

### SEO refresh (Phase 3): the `aquaseos` collection

There is **one SEO document per page**, keyed by `pageKey` (`src/services/seoReadiness.js`):

| Page | `pageKey` | `route` |
|---|---|---|
| Product | `product.<slug or id>` | `/product/<slug or id>` |
| Category | `category.<title>` | `/category/<title>` |
| Subcategory | `subcategory.<title>` | `/subcategory/<title>` |
| Blog | `blog.<slug>` | `/blog/<slug>` |
| Static pages | fixed keys (home and others) | |

Schema (`src/models/seo.js`):

| Field | Rule |
|---|---|
| `pageKey` | Unique, lowercase, ≤100, `^[a-z0-9]+(?:[._-][a-z0-9]+)*$` |
| `route` | Required, ≤500 |
| `title` | Required, ≤120 |
| `description` | ≤500 |
| `keywords` | `string[]`; each ≤100, at most 50 |
| `canonicalUrl` | ≤1000 |
| `robots` | Default `index,follow` |
| `ogTitle`, `twitterTitle` | ≤120 |
| `ogDescription`, `twitterDescription` | ≤500 |
| `ogImage`, `twitterImage` | |
| `schemaJson` | |
| `active` | |
| `aiLocked` | Staff pin a page as hand-written |
| `aiRefreshedAt` | |
| `aiPrevious` | `{title, description, keywords, replacedAt}`, for rollback |
| `createdBy`, `updatedBy` | |
| timestamps | |

**Blog keywords live in two places:**

- `aquablogs`: `keywords`, `keyphrases`, `shortDescription` (the article's own fields)
- `aquaseos`: the `blog.<slug>` page's meta `title`, `description` and `keywords`

The 10-day refresh must decide which it updates. Keyphrases only exist on `aquablogs`.

**How AquaKart's own weekly job writes** (`src/jobs/aiSeoRefresh.js`). The platform adapter mirrors these rules so the two systems behave the same:

- **Skips** pages that are `aiLocked`, `active: false` or `noindex`, or were refreshed within `SEO_AI_MIN_DAYS_BETWEEN_REFRESH`.
- **Skips pages a person edited recently:** `updatedBy` is set and `updatedAt` is more than 60 s after `aiRefreshedAt`, within `SEO_AI_STAFF_EDIT_GRACE_DAYS`. So **the platform must never set `updatedBy`**; that field is how a human edit is detected.
- **Writes live, immediately**, with `$set` `{title, description, keywords, aiRefreshedAt}`. It saves the replaced values in `aiPrevious`, and re-checks `aiLocked: {$ne: true}` in the update filter.
- **OG and Twitter copy** is updated only where it was empty or mirrored the old meta text, so hand-written social copy survives.
- **Creates** a missing SEO doc with `pageKey`, `route`, `canonicalUrl` and `robots: "index,follow"`.
- **Rejects weak output:** title under 15 characters, description under 50, or fewer than 3 keywords. At most 12 keywords.

**There is no pending or review state.** AquaKart's job applies changes live, relying on `aiPrevious` for rollback. The owner's day-9 rule (suggestions first, applied after approval) needs a place for suggestions; see the open question in docs/phases.md. A suggestion subdocument on the SEO doc (for example `aiSuggestion: {title, description, keywords, status, suggestedAt, dueAt}`) would fit, and AquaKart's Mongoose model ignores fields it does not define. But AquaKart's admin would need a view to approve it.

### Turn off AquaKart's own AI jobs at cut-over

Set `BLOG_AI_DRAFTS_ENABLED=false` and `SEO_AI_REFRESH_ENABLED=false` in AquaKart. Otherwise both systems write drafts and rewrite SEO.

## Must not touch

These are not called by the platform, ever:

- Cart, checkout, orders and payments
- `/v1/order/*`, `/v1/checkout/*`, `/v1/payments*`, `/v1/crm/*`

"Initiate checkout" (spec §5) means returning product links and cart instructions to the frontend. `POST /v1/checkout/quote` needs the **customer's own** JWT and stays a frontend call.

## Overlap to resolve with the owner

- AquaKart already runs **Gemini-based AI**:
  - storefront chat at `/v1/ai/chat` and `/v1/ai/chat/stream`
  - a CRM Gemini proxy
  - a scheduled `blog-ai-drafts` job that writes drafts **directly to its DB**
  - a weekly SEO refresh job

  When the platform takes over blogs and chat, the matching AquaKart jobs should be disabled (`BLOG_AI_DRAFTS_ENABLED=false`) to avoid duplicate drafts.
- Safe write target for an assistant: the public lead forms `POST /v1/leads/planner|enquiry|product-consultation`. These are rate-limited to 30 per 15 min.

## Issues found in AquaKart (not fixed; owner to decide)

- Several product endpoints expose `dpPrice` publicly (listed above).
- `GET /v1/blog/:id` returns drafts publicly. `GET /v1/order/:id` is unauthenticated.
- Hardcoded fallback API keys appear in `src/utils/sendWhatsApp.js` (and possibly `fast2SmsWhatsApp.js`).
- `swagger-output.json` is regenerated on every boot.
- There is no global error handler, so errors return Express's default HTML 500.
