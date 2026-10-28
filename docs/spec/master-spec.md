# MASTER SPEC — Unified AI Platform

> Source of truth for scope. Supplied by the project owner on 2026-10-25.
> **Amendment (2026-10-25):** Section 16 (Admin Dashboard) was removed by the owner. All dashboard
> references (`apps/dashboard`, the Phase 6 "Admin dashboard" item, deliverable "Admin dashboard")
> were removed with it. Sections keep their original numbers so references stay stable.
> **Amendment (2026-10-25):** A third brand, **Spasta**, is in scope alongside Aquakart and PawSattva
> (requested earlier by the owner). Its integration contract is not yet known.
> **Amendment (2026-10-25): agent failure limit.** An agent job runs at most **2 attempts in total**
> (the first run plus one retry). After the second failure it stops, is marked FAILED, goes to the
> dead-letter queue and is surfaced for human review. Enforced by `AGENT_MAX_ATTEMPTS` (default 2,
> capped at 2 in `packages/config`). This is separate from LLM-call retries inside the gateway.
> **Amendment (2026-10-25): 10-day SEO cycle (requested; Phase 3).** For AquaKart and PawSattva:
> automated blog generation plus a refresh of SEO keywords, keyphrases and descriptions **every 10
> days**. Suggestions are generated on day 9 (one day before the deadline) and applied only after
> approval. Open decisions are listed in docs/phases.md (Phase 3).
> **Amendment (2026-10-25): direct writes (supersedes "prefer existing APIs" in §3C).** PawSattva content
> is written directly to Firestore in the review state; AquaKart content directly to its MongoDB in the
> draft state. Authorized by the owner for new review/draft content and approved changes only. See
> docs/decisions/0002-direct-writes-pawsattva-aquakart.md.

> **Amendment (2026-10-25): reels via MoneyPrinterTurbo.** For PawSattva and AquaKart, reels are
> rendered by a self-hosted MoneyPrinterTurbo service (footage, TTS, subtitles, music, 9:16 render),
> driven by the platform's own scripts, review, approval and publishing. This is an owner-approved
> deviation from "Remotion" in §2/§9 (Remotion remains a possible second provider).
> **Spasta uses a different API** and is not part of these content/reel features.
> See docs/decisions/0004-moneyprinterturbo-render-provider.md.

## Role

Act as a Principal Software Architect, Senior TypeScript/Node.js Engineer, AI Systems Engineer, and DevOps Engineer.

Build a production-ready, scalable, secure, modular **Unified AI Platform** that serves multiple applications and brands through a single Node.js backend.

This is not a prototype or demonstration. Implement working infrastructure, real API integrations, database models, background workers, automated tests, and deployment configurations.

Do not create fake integrations, mock production responses, or hardcoded AI results.

Where third-party credentials are unavailable, implement the complete integration behind a typed interface, provide environment configuration, and clearly document what is required to activate it.

Do not overwrite existing application databases, modify production data without authorization, or deploy automatically.

---

# 1. PROJECT OVERVIEW

Build one centralized AI platform that powers:

**Aquakart**
- AI shopping assistant
- Product recommendations
- Conversational product discovery
- Product comparisons
- AI customer support
- Automated SEO blogs
- Instagram post generation
- Instagram reels generation
- Content scheduling and publishing

**PawSattva**
- Paw GPT conversational assistant
- Pet care information
- Pet wellness content
- Automated SEO blogs
- Instagram post generation
- Instagram reels generation
- Content scheduling and publishing

**Future applications**
- New brands
- Custom AI assistants
- Voice assistants
- Internal automation agents
- AI-powered customer support
- Additional publishing channels

The system must support multiple brands without duplicating the core AI infrastructure.

---

# 2. MANDATORY TECHNOLOGY STACK

Use:

- Node.js current supported LTS version
- TypeScript with strict mode
- Fastify for REST APIs
- MongoDB for central platform persistence
- Mongoose for schema modeling
- Firebase Admin SDK for PawSattva integration
- MongoDB or existing authenticated backend APIs for Aquakart integration
- OpenRouter as the primary LLM provider
- Redis + BullMQ for background jobs
- Zod for input validation
- Pino for structured logging
- Vitest for unit and integration tests
- OpenAPI/Swagger for API documentation
- Server-Sent Events for streaming LLM responses
- Sharp for image processing
- FFmpeg and Remotion for video rendering
- S3-compatible object storage for media
- Docker and Docker Compose for local development and deployment

Use pnpm workspaces to organize the codebase.

Avoid unnecessary dependencies and overly complex abstractions.

---

# 3. DATABASE ARCHITECTURE

There are three distinct data responsibilities.

### A. Central AI Platform — MongoDB

The central platform uses its own MongoDB database.

Collections:

- brands
- applications
- api_clients
- assistant_configs
- agent_configs
- chat_sessions
- chat_messages
- campaigns
- content_briefs
- blog_drafts
- social_posts
- reels
- media_assets
- automation_jobs
- publishing_records
- approval_requests
- knowledge_documents
- knowledge_chunks
- llm_usage_logs
- audit_logs
- system_settings

Every brand-specific document must include a brandId.

Application-specific documents must include an applicationId where relevant.

Enforce tenant isolation at the service and repository layers, not only through frontend filtering.

Create appropriate indexes, TTL policies for temporary records, pagination, retention settings, and schema validation.

Do not store API keys or service account credentials in plaintext MongoDB documents.

### B. PawSattva — Firebase

PawSattva currently uses Firebase.

Integrate through the Firebase Admin SDK using a Firebase service account.

Support:

- Secure service account initialization
- Firestore document access
- Firebase authentication token verification
- Existing PawSattva blog draft schema
- Creating blog drafts
- Reading permitted content
- Publishing approved content through authorized workflows
- Existing application-specific integrations

Do not assume Firestore collection names or schemas.

Inspect the existing PawSattva implementation or request its contract before finalizing the adapter.

Use the Firebase Admin SDK only on trusted server-side infrastructure.

### C. Aquakart — MongoDB

Aquakart uses MongoDB.

Support:

- Product catalog retrieval
- Categories and subcategories
- Product recommendations
- Product comparison
- Inventory availability
- Approved content submission
- Existing backend integrations

Prefer Aquakart's existing authenticated backend APIs when available.

Do not duplicate Aquakart business logic inside the AI platform.

Do not allow AI agents to directly modify orders, payments, inventory, or customer records without explicit authorization.

---

# 4. SHARED LLM GATEWAY

Create a centralized LLM gateway.

All AI agents and frontend assistants must access LLM providers through this gateway.

Primary provider: OpenRouter.

Features:

1. Centralized provider configuration
2. Multiple model support
3. Configurable model routing
4. Streaming responses
5. Structured JSON outputs
6. Tool/function calling
7. Request cancellation
8. Request timeouts
9. Retry with exponential backoff
10. Rate limiting
11. Token usage tracking
12. Cost tracking by brand and application
13. Per-agent model configuration
14. Per-brand token budgets
15. Provider fallback
16. Conversation context management
17. Secure prompt handling
18. Error normalization

Use one central OpenRouter credential by default, stored securely in server environment secrets.

Never expose the provider API key to frontend applications.

The gateway should support adding other LLM providers later without rewriting the agents.

Do not assume OpenRouter provides image, audio, or video capabilities for every selected model. Implement separate provider interfaces for those capabilities.

---

# 5. REAL-TIME CHAT ENGINE

Implement a production-grade chat engine for frontend applications.

Required API endpoints:

POST /api/v1/chat/sessions

GET /api/v1/chat/sessions

GET /api/v1/chat/sessions/:id/messages

POST /api/v1/chat/completions

POST /api/v1/chat/stream

DELETE /api/v1/chat/sessions/:id

Features:

- Real-time token streaming using SSE
- Persistent conversation history
- Session ownership validation
- Conversation titles
- Message pagination
- Assistant-specific system prompts
- Context-window management
- Conversation summarization
- Tool execution
- Tool execution authorization
- Usage limits
- Request cancellation
- Secure error handling
- Input validation
- Output moderation policies
- Prompt injection defenses

Support anonymous frontend sessions with restricted quotas where explicitly enabled.

For authenticated sessions, verify the frontend application's identity provider or trusted backend authentication.

Never trust a client-supplied brandId or userId without verifying authorization.

### Aquakart AI Assistant

Create a specialized shopping assistant.

Capabilities:

- Understand customer needs
- Retrieve relevant products
- Recommend suitable products
- Compare specifications
- Explain product features
- Check current prices and availability
- Return structured product cards
- Provide product detail references
- Initiate approved cart or checkout workflows

All prices, stock levels, and product claims must come from trusted Aquakart data.

Never fabricate product information.

Payment processing remains with Aquakart's existing secure payment infrastructure.

### PawSattva Paw GPT

Create a specialized pet assistant.

Capabilities:

- Pet care questions
- Nutrition information
- Grooming guidance
- Pet wellness education
- Context-aware follow-up questions
- Relevant content recommendations

Use curated knowledge and trusted sources where available.

For medical emergencies or serious health symptoms, provide appropriate veterinary escalation rather than pretending to diagnose or prescribe.

Maintain distinct assistant configurations for Aquakart and PawSattva.

---

# 6. AGENT ENGINE

Implement a reusable agent framework.

Each agent must support:

- Unique identifier
- Brand association
- Versioned configuration
- System instructions
- Model selection
- Allowed tools
- Tool permissions
- Execution limits
- Token budget
- Execution timeout
- Retry policy
- Structured output schema
- Execution history
- Logging
- Cancellation
- Approval requirements

Initial agents:

1. Research Agent
2. SEO Blog Agent
3. Instagram Content Agent
4. Image Generation Agent
5. Reel Script Agent
6. Voiceover Agent
7. Video Assembly Agent
8. Content Review Agent
9. Publishing Agent
10. Shopping Assistant Agent
11. Paw GPT Assistant Agent

Do not implement agents as uncontrolled recursive LLM loops.

Use bounded, typed workflows with deterministic transitions wherever possible.

Agents must not invoke arbitrary network endpoints, execute arbitrary code, or access unauthorized databases.

---

# 7. AUTOMATED BLOG SYSTEM

Implement automated SEO blog generation.

Workflow:

Topic selection
→ Research
→ Content brief
→ SEO outline
→ Article generation
→ Factual validation
→ SEO validation
→ Image generation or selection
→ Draft creation
→ Approval
→ Publishing

Blog requirements:

- SEO title
- Meta description
- URL slug
- Focus keyword
- Secondary keywords
- Structured headings
- Article content
- Internal linking suggestions
- External references
- Featured image
- Alt text
- FAQ section when useful
- Structured data recommendations
- Brand-specific CTA

Avoid fabricated references, unsupported medical claims, duplicate content, and keyword stuffing.

For PawSattva, save approved drafts through the Firebase integration.

For Aquakart, use its authorized backend integration.

Support draft-first publishing as the default.

---

# 8. INSTAGRAM AUTOMATION

Implement Instagram content workflows.

Features:

- Post topic generation
- Caption generation
- Hashtag suggestions
- Brand-specific image generation
- Square 1:1 assets
- Portrait 4:5 assets
- Story/Reel 9:16 assets
- Carousel content
- Brand logo placement
- Brand color configuration
- Media preview
- Approval workflow
- Scheduled publishing
- Publishing status tracking

Use the official Meta Instagram publishing APIs.

Validate account eligibility, permissions, supported media formats, API limits, and publishing requirements.

Do not use browser automation to bypass Instagram restrictions.

Brand configurations:

Aquakart:
- Water solutions
- Water softeners
- Product education
- Shopping assistant promotion
- Website: https://aquakart.co.in

PawSattva:
- Pet wellness
- Pet education
- Paw GPT promotion
- Website: https://pawsattva.com

Create reusable templates rather than generating every visual layout from scratch.

---

# 9. AUTOMATED REELS SYSTEM

Implement an end-to-end reels pipeline.

Workflow:

Topic
→ Script
→ Scene breakdown
→ Visual assets
→ Voiceover
→ Video assembly
→ Subtitles
→ Branding
→ Rendering
→ Validation
→ Approval
→ Publishing

Use:

- Remotion for programmatic video composition
- FFmpeg for media processing
- Pluggable TTS provider
- Pluggable image/video asset providers

Support:

- 9:16 vertical video
- Configurable duration
- Scene transitions
- Subtitles
- Brand watermark
- Background music where licensed
- Voiceover synchronization
- Thumbnail generation
- Rendering progress
- Retry and failure handling

Do not assume AI-generated video clips are available without a configured provider.

Provide a working initial reel pipeline using still images, motion effects, captions, and voiceover.

Store rendered files in object storage, not MongoDB.

---

# 10. SHARED CAMPAIGN ENGINE

This is a critical requirement.

Blog posts, Instagram posts, and reels must remain aligned.

Create one campaign entity containing:

- Brand
- Campaign objective
- Topic
- Audience
- Research brief
- Verified facts
- Keywords
- Tone
- Core message
- Call to action
- Publishing window
- Content status

Example:

Campaign: Hard Water Problems

Generate:

- One SEO blog
- One Instagram poster
- One Instagram carousel
- One Instagram reel

All generated content must reuse the same approved research brief and consistent messaging.

Avoid repeated research and unnecessary AI calls.

Support content reuse, revision history, and dependency tracking.

---

# 11. AUTOMATION SCHEDULER

Use BullMQ and Redis.

Support:

- Daily blog generation
- Weekly content campaigns
- Scheduled Instagram posts
- Scheduled reels
- Recurring agent tasks
- Manual execution
- Job cancellation
- Failed-job retries
- Dead-letter handling
- Job progress tracking
- Concurrency limits
- Idempotency keys

Live chat workloads must be isolated from background automation.

Never allow a heavy video rendering job to block real-time chat requests.

Use separate worker processes and configurable concurrency.

Prevent duplicate publishing through idempotent publishing operations.

---

# 12. APPROVAL SYSTEM

Implement content states:

DRAFT
→ GENERATED
→ VALIDATING
→ PENDING_APPROVAL
→ APPROVED
→ SCHEDULED
→ PUBLISHING
→ PUBLISHED

Also support:

REJECTED
FAILED
CANCELLED

Persist state transitions and audit records.

Only authorized reviewers may approve publication.

Support regeneration, editing, rescheduling, and rejection reasons.

Default to approval-first publishing.

Make future automatic publishing configurable by brand and content type.

---

# 13. SECURITY

Mandatory requirements:

- JWT/Firebase token verification
- API client authentication
- Role-based access control
- Brand-level data isolation
- Rate limiting
- CORS allowlists
- Secret management
- Input validation
- Output validation
- Tool permission checks
- SSRF protection
- Prompt injection defenses
- Secure logging
- PII minimization
- Audit trails
- Webhook signature verification
- Media upload validation
- Least-privilege database credentials

Never expose Firebase service account credentials, OpenRouter keys, MongoDB connection strings, or Meta access tokens to the browser.

Use separate credentials for development, staging, and production.

---

# 14. PROJECT STRUCTURE

Create the following monorepo:

```text
unified-ai-platform/
├── apps/
│   ├── api/
│   └── worker/
│
├── packages/
│   ├── core/
│   ├── config/
│   ├── database/
│   ├── shared-types/
│   ├── auth/
│   ├── llm-gateway/
│   ├── chat-engine/
│   ├── agent-engine/
│   ├── campaign-engine/
│   ├── automation-engine/
│   ├── media-engine/
│   └── integrations/
│       ├── pawsattva-firebase/
│       ├── aquakart-mongodb/
│       ├── openrouter/
│       ├── instagram-meta/
│       ├── object-storage/
│       └── tts/
│
├── agents/
│   ├── research/
│   ├── blog/
│   ├── instagram/
│   ├── image/
│   ├── reels/
│   ├── review/
│   ├── publishing/
│   ├── aquakart-shopping/
│   └── pawsattva-paw-gpt/
│
├── infrastructure/
│   ├── docker/
│   ├── scripts/
│   └── deployment/
│
├── tests/
├── docs/
├── .env.example
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

---

# 15. ENVIRONMENT CONFIGURATION

Create a complete `.env.example`.

Include:

```env
NODE_ENV=development
PORT=4000

MONGODB_URI=
REDIS_URL=

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
DEFAULT_LLM_MODEL=

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

AQUAKART_API_BASE_URL=
AQUAKART_SERVICE_TOKEN=

META_APP_ID=
META_APP_SECRET=
META_ACCESS_TOKEN=

S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

JWT_ISSUER=
JWT_AUDIENCE=
CORS_ALLOWED_ORIGINS=

LOG_LEVEL=info
```

Do not commit actual secrets.

Validate required environment variables on startup.

Use environment-specific validation so optional integrations do not prevent unrelated services from starting.

---

# 16. ADMIN DASHBOARD — REMOVED

Removed by the project owner on 2026-10-25. Do not build a dashboard as part of this scope.

---

# 17. OBSERVABILITY AND COST CONTROL

Implement:

- Structured logs
- Request IDs
- Agent execution traces
- Job execution history
- Provider latency metrics
- Token usage per request
- Cost per brand
- Cost per agent
- Daily/monthly budgets
- Retry statistics
- Publishing failures
- API health checks
- Queue health monitoring

Track costs separately for:

- LLM tokens
- Image generation
- TTS
- Video rendering
- Object storage

Implement budget enforcement rather than merely displaying estimated costs.

---

# 18. TESTING

Create tests for:

- Authentication
- Tenant isolation
- LLM gateway
- Streaming responses
- Tool permissions
- Chat persistence
- Firebase adapter
- Aquakart adapter
- Agent execution
- Campaign consistency
- Job scheduling
- Retry and idempotency
- Approval transitions
- Publishing workflows
- API validation
- Cost accounting

Use mocked external providers in automated tests, but real integrations in production code.

Provide integration tests using isolated test databases and local service containers where practical.

---

# 19. IMPLEMENTATION ORDER

Implement incrementally.

### Phase 1 — Core Infrastructure

- Initialize monorepo
- Configure TypeScript
- Configure Fastify
- Connect MongoDB
- Connect Redis
- Create brand/application models
- Implement authentication
- Implement LLM gateway
- Add logging and OpenAPI

### Phase 2 — Live AI Chat

- Chat sessions
- Streaming responses
- Persistent history
- Assistant configuration
- Tool calling
- Rate limiting
- Aquakart assistant adapter
- PawSattva assistant adapter

### Phase 3 — Content Automation

- Research agent
- Blog agent
- Campaign engine
- Draft storage
- Firebase blog integration
- Aquakart blog integration
- Approval workflow

### Phase 4 — Social Automation

- Instagram content agent
- Image generation provider
- Media templates
- Meta publishing integration
- Scheduling

### Phase 5 — Reels

- Script generation
- TTS
- Scene generation
- Remotion rendering
- Subtitles
- Publishing

### Phase 6 — Hardening

- Analytics
- Budget controls
- Monitoring
- Load testing
- Security testing
- Deployment documentation

---

# 20. CODING QUALITY RULES

Follow these requirements strictly.

1. Use strict TypeScript. Avoid `any`.
2. Separate domain logic from HTTP handlers.
3. Use dependency injection where beneficial.
4. Keep modules independently testable.
5. Use typed interfaces for external integrations.
6. Use Zod for boundary validation.
7. Use consistent error responses.
8. Implement graceful shutdown.
9. Implement database connection recovery.
10. Avoid blocking the Node.js event loop.
11. Use background workers for expensive tasks.
12. Do not hardcode provider models, prices, or secrets.
13. Do not silently swallow errors.
14. Avoid unnecessary abstractions.
15. Write meaningful tests.
16. Document important architectural decisions.
17. Avoid duplicating logic across brands.
18. Preserve existing application data and contracts.
19. Never claim an integration works until it has been tested.
20. Ensure every implemented phase can start and run independently.

---

# 21. EXPECTED DELIVERABLES

Provide:

1. Working monorepo source code
2. MongoDB schemas and indexes
3. Firebase integration
4. Aquakart integration
5. Shared LLM gateway
6. Streaming chat API
7. Reusable agent framework
8. Blog automation pipeline
9. Instagram automation pipeline
10. Reel generation pipeline
11. Approval workflow
12. Scheduler and workers
13. ~~Admin dashboard~~ (removed — see Section 16)
14. Docker configuration
15. Environment variable documentation
16. API documentation
17. Automated tests
18. Deployment guide
19. Architecture documentation
20. Clear integration checklist

For each phase, report:

- What was implemented
- Which files were created or modified
- Which tests passed
- Which integrations were verified
- Which credentials or external contracts are still needed
- Remaining limitations

Do not report placeholder implementations as completed functionality.

---

# 22. FIRST ACTION

Before coding:

1. Inspect the current repository if one exists.
2. Identify reusable code and existing project conventions.
3. Produce a concise architecture and dependency plan.
4. Identify unknown Firebase and Aquakart API contracts.
5. Define the core MongoDB models.
6. Define the LLM gateway interfaces.
7. Define the chat and agent API contracts.
8. Identify security and deployment risks.

Then begin implementing Phase 1.

Do not attempt to build all phases in a single unverified code generation pass.

Complete each phase with tests and working startup instructions before proceeding.

**Final objective: Build one reliable AI infrastructure that powers Aquakart AI, PawSattva Paw GPT, automated blogs, Instagram content, reels, and future AI applications through a centralized Node.js backend while preserving the existing Firebase and MongoDB systems.**
