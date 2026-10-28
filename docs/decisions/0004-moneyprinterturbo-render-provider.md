# ADR 0004: MoneyPrinterTurbo as the first reel render provider

Date: 2026-10-25. Status: accepted (owner request: bring MoneyPrinterTurbo's features to PawSattva and AquaKart).

## Context

Spec §9 names Remotion and FFmpeg for video, with pluggable TTS and asset providers. MoneyPrinterTurbo (MIT, Python) already implements most of the reel pipeline:

- stock-footage matching
- more than ten TTS providers
- subtitles
- background music
- transitions
- 9:16 rendering

## Decision

- **Integrate MPT as a self-hosted render provider behind a typed client** (`@uap/moneyprinter`), instead of rebuilding these features first in Remotion.
- **The platform keeps** script writing (LLM gateway), review, approval, storage, scheduling and publishing.
- **MPT's own LLM and auto-publishing are not used.**

## Consequences

- **Operations:** one more service to run (Python, a heavy media workload), internal-only and authenticated with an API key.
- **Spec deviation:** the composition engine is MPT (MoviePy/FFmpeg), not Remotion. It is recorded here as an owner-approved deviation. Remotion stays an option for branded template reels as a second provider behind the same worker step.
- **Gaps MPT does not cover:** brand logo watermark and thumbnail. The worker adds them with FFmpeg after rendering.
- **Licensing:**
  - MPT itself is MIT.
  - Stock footage follows the Pexels and Pixabay licenses.
  - Edge TTS is an unofficial Microsoft endpoint, for evaluation only.
  - Background music must be licensed per brand.
- **Upgrade risk:** MPT changes quickly. Pin an image digest and re-verify the wire contract (see [integrations/moneyprinter.md](../integrations/moneyprinter.md)) on each upgrade.
- **Scope:** PawSattva and AquaKart. Spasta uses a different API and is not part of this integration.
