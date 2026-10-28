# ADR 0002: Direct writes to PawSattva Firestore and AquaKart MongoDB

Date: 2026-10-25. Status: accepted (owner decision). Supersedes ADR 0001 §4.

## Decision

- **PawSattva:** the platform writes directly to Firestore with the Firebase Admin SDK. New content goes in the review state (`blogs.status = "pending_review"`).
- **AquaKart:** the platform connects directly to AquaKart's MongoDB. New content goes in the draft state (`AquaBlog.status = "draft"`, `generatedBy = "ai"`).
- Content is reviewed in each brand's existing admin panel, where the admin panels already list these states.

## Authorization

Spec §3 forbids modifying production data without authorization. The owner authorized these writes on 2026-10-25, **limited to**:

1. **Creating** new content in the review or draft state.
2. **Applying approved changes** (for example SEO updates) after review.

Publishing, deleting, or editing live content without approval is still out of scope. So is any write outside blogs and SEO (orders, payments, users, products, inventory).

## Consequences

- **Each app's own validation is bypassed.** AquaKart's Mongoose validation does not run on raw driver writes, and Firestore rules do not apply to the Admin SDK. Each adapter must re-implement the target schema's rules and have tests that pin them.
- **Credentials:**
  - AquaKart gets a dedicated least-privilege MongoDB user, with collection-level privileges (see [integrations/aquakart.md](../integrations/aquakart.md)).
  - Firebase service accounts cannot be scoped per collection, so the PawSattva write guard lives in code.
- **Schema coupling:** schema changes in either app can break the adapters silently. Adapters validate the documents they write, and the integration docs record the schema version they were built against.
- **Overlap:** AquaKart's own AI jobs (`blog-ai-drafts`, `seo-ai-refresh`) must be disabled at cut-over.
- **Config:** `AQUAKART_MONGODB_URI` replaces `AQUAKART_API_BASE_URL` and `AQUAKART_SERVICE_TOKEN`. The `PAWSATTVA_*` draft-API variables are removed. Config refuses an AquaKart URI that equals the platform database URI.
