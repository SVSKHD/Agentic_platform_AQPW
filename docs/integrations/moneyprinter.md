# MoneyPrinterTurbo (MPT): reel render provider

Source: https://github.com/harry0703/MoneyPrinterTurbo, main branch, read 2026-10-25.
- **License:** MIT.
- **Stack:** Python 3.11, FastAPI (`/api/v1`), a Streamlit WebUI and a CLI.
- **Distribution:** Docker image `ghcr.io/harry0703/moneyprinterturbo`.

**Scope (owner, 2026-10-25):** PawSattva and AquaKart. Spasta uses a different API and is out of scope.

## What MPT does

It turns a topic and script into a finished short video: stock or own footage, voiceover, subtitles, background music, and a 9:16 / 1:1 / 16:9 render (1080×1920 for 9:16).

| MPT feature | What it offers | How the platform uses it |
|---|---|---|
| Script generation (many LLM providers, including OpenRouter) | Writes the narration | **Not used.** Scripts come from our Reel Script agent through the LLM gateway (cost per brand, brand rules, review). We always send `video_script`, so MPT never calls an LLM. |
| Footage: Pexels, Pixabay, Coverr, local uploads, AI text-to-video, text-to-image | Matches clips to search terms | Pexels or Pixabay to start (`searchTerms` from our script step). `local` for brand-owned media: AquaKart product photos (`aquaproducts.photos`) and PawSattva blog images. AI video only once a provider is chosen and budgeted. |
| TTS: Edge (free), Azure, ElevenLabs, Gemini, and others | Voiceover | Per-brand voice preset. **Edge TTS is for evaluation only**: it is an unofficial endpoint. Use Azure or ElevenLabs with our own account in production. |
| Subtitles: `edge` (TTS timing) or `whisper` (faster-whisper; `large-v3` ≈3 GB, GPU helps) | Burned-in captions with font, color, stroke and position | On by default, styled from brand colors. Start with `edge` timing, no GPU. |
| Background music: local, random, AI | Music under the voice, with its own volume | **Only licensed tracks** uploaded per brand (spec §9). Off until the brand supplies a library. |
| Transitions, clip length, concat mode, fit mode, image motion (zoom) | Editing | Sequential clips, FadeIn, about 4 s clips, zoom on stills (a "stills + motion + captions + voice" reel, which is spec §9's required baseline) |
| Batch / `video_count` | Several variants per request | 1 per request. Variants are separate jobs, so each is budgeted and approved. |
| Auto-upload to TikTok, Instagram, YouTube | Cross-posting | **Never enabled.** Publishing goes through approval and our Publishing agent (idempotent, audited). |
| WebUI (Streamlit) | Manual tool | Not deployed in production. |

## Pipeline (Phase 5)

```text
campaign brief (§10) → Reel Script agent (gateway)  → Content Review agent (claims; vet-safe for PawSattva)
  → worker: MoneyPrinterClient.createVideo(script, searchTerms, brand preset)
  → poll getTask() until complete | failed     (job attempts: max 2, owner rule)
  → download() → S3 (media_assets) → deleteTask() on MPT
  → reel status PENDING_APPROVAL → reviewer approves → Publishing agent → Instagram Reel (Meta Graph)
```

- Rendering runs only in the **worker**, never in the API process (spec §11).
- MPT has its own queue and returns 429 when full. The client maps that to `rate_limited`, which the job retries within its 2 attempts.

## Brand presets (stored as brand data in Phase 5, not code)

| | PawSattva | AquaKart |
|---|---|---|
| Voice | Indian English, warm (e.g. Azure `en-IN` female) | Indian English, clear (e.g. Azure `en-IN` male). Hindi variant optional. |
| Footage terms | dogs, cats, pet care, vet, grooming | water, shower, kitchen tap, water softener, plumbing |
| Own media (`local`) | Blog featured images | Product photos from `aquaproducts` (dealer price never involved) |
| Subtitle colors | From brand `branding` colors | From brand `branding` colors |
| Watermark/logo | `branding.logoUrl` (spec §9). MPT has no watermark option, so it is overlaid with FFmpeg after rendering. | same |

## Client: `@uap/moneyprinter`

`packages/integrations/moneyprinter`, unit-tested against MPT's documented wire format (no live MPT):

| Method | Calls |
|---|---|
| `createVideo` | `POST /api/v1/videos` |
| `getTask` | `GET /api/v1/tasks/{id}` (state `4` processing, `1` complete, `-1` failed, plus `failed_stage` and `error`) |
| `deleteTask` | `DELETE /api/v1/tasks/{id}` |
| `download` | `GET /api/v1/download/{path}` |
| `uploadMaterial` | `POST /api/v1/video_materials` |

Safety rules built into the client:
- An API key is required (`x-api-key`). **MPT accepts unauthenticated requests when its `[app] api_key` is empty.**
- A script is required, so MPT's own LLM is never used.
- Output URLs are resolved only against the MPT host, and `..` paths are rejected (no SSRF via task responses).

Config: `MONEYPRINTER_BASE_URL` and `MONEYPRINTER_API_KEY` (an all-or-nothing group).

## Running it

- **Compose:** `docker compose --profile video up` starts it on the internal network only, with no host port.
- **Config:** copy MPT's `config.example.toml` to `infrastructure/moneyprinter/config.toml` (git-ignored) and set:
  - `[app] api_key`, the same value as `MONEYPRINTER_API_KEY`
  - Pexels and Pixabay API keys (free, but required)
  - TTS provider credentials
  - cross-posting and auto-upload left **off**
- **Hardware:** MPT recommends 6–8 cores and 8 GB RAM. A GPU helps only with whisper subtitles.

## Not verified yet

- **MPT has not been run against this platform.** There is no Docker on the dev machine and no Pexels or TTS keys. Verify the image's API port and paths, the `/api/v1` prefix and the download path format against the running service's `/docs`.
- **Pin an image digest** after evaluation. Track MPT releases: it is very active (1,190+ commits, many open PRs), and its API may change.
