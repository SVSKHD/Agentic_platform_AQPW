// Client for a self-hosted MoneyPrinterTurbo (MPT) service, used as the reel *render* provider.
// MPT: https://github.com/harry0703/MoneyPrinterTurbo (MIT). See docs/integrations/moneyprinter.md.
//
// Division of work:
// - The platform writes the script (through the LLM gateway: cost tracking, brand rules, review).
//   We always send `video_script`, so MPT never calls an LLM of its own.
// - MPT does footage matching, TTS, subtitles, background music and the 9:16 render.
// - MPT's own auto-publishing is never used; reels go through approval + the Publishing agent.
//
// Wire contract from MPT's app/models/schema.py and app/controllers/v1/video.py (main branch,
// read 2026-10-25). Re-check against the deployed service's /docs when upgrading MPT.
import { z } from "zod";
import { AppError } from "@uap/core";

export interface MoneyPrinterOptions {
  /** e.g. http://moneyprinter:8080 (internal network only). */
  baseUrl: string;
  /** MPT `[app] api_key`, sent as x-api-key. MPT runs WITHOUT auth when its key is empty, so it is required here. */
  apiKey: string;
  fetch?: typeof fetch;
}

export const reelRenderRequestSchema = z.object({
  /** Topic, used by MPT for footage search when searchTerms is empty. */
  subject: z.string().trim().min(1).max(300),
  /** Narration text, approved by our own review step. Required: MPT must not write scripts. */
  script: z.string().trim().min(20).max(5_000),
  /** Footage search terms (English works best with stock libraries). */
  searchTerms: z.array(z.string().trim().min(1)).min(1).max(20),
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
  /** Seconds per footage clip, MPT range 1-15. */
  clipDurationSec: z.number().int().min(1).max(15).default(4),
  /** Footage source. "local" = materials uploaded with uploadMaterial() (e.g. brand product photos). */
  source: z.enum(["pexels", "pixabay", "local"]).default("pexels"),
  materials: z.array(z.object({ url: z.string().min(1), durationSec: z.number().int().min(0).default(0) })).optional(),
  concat: z.enum(["random", "sequential"]).default("sequential"),
  transition: z.enum(["none", "Shuffle", "FadeIn", "FadeOut", "SlideIn", "SlideOut", "ZoomIn", "ZoomOut"]).default("FadeIn"),
  voice: z.object({
    /** MPT voice id, e.g. "en-IN-NeerjaNeural-Female" (Edge) or a provider-specific id. */
    name: z.string().min(1),
    rate: z.number().min(0.5).max(2).default(1),
    volume: z.number().min(0).max(2).default(1),
  }),
  music: z
    .object({
      /** "none" disables music. Only licensed tracks may be uploaded to MPT (spec §9). */
      type: z.enum(["none", "random", "file"]),
      file: z.string().optional(),
      volume: z.number().min(0).max(1).default(0.15),
    })
    .default({ type: "none", volume: 0.15 }),
  subtitles: z
    .object({
      enabled: z.boolean().default(true),
      position: z.enum(["top", "center", "bottom"]).default("bottom"),
      fontName: z.string().optional(),
      fontSize: z.number().int().min(10).max(200).default(60),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
      strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
      strokeWidth: z.number().min(0).max(10).default(1.5),
    })
    .default({ enabled: true, position: "bottom", fontSize: 60, color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 1.5 }),
});

export type ReelRenderRequest = z.input<typeof reelRenderRequestSchema>;

/** Maps our request to MPT's VideoParams (snake_case). Exported for tests. */
export const toVideoParams = (input: ReelRenderRequest) => {
  const req = reelRenderRequestSchema.parse(input);
  if (req.source === "local" && !req.materials?.length) {
    throw new AppError("bad_request", "source 'local' needs at least one uploaded material");
  }
  return {
    video_subject: req.subject,
    video_script: req.script,
    video_terms: req.searchTerms,
    video_aspect: req.aspect,
    video_clip_duration: req.clipDurationSec,
    video_source: req.source,
    ...(req.materials?.length && { video_materials: req.materials.map((m) => ({ provider: "local", url: m.url, duration: m.durationSec })) }),
    video_concat_mode: req.concat,
    video_transition_mode: req.transition === "none" ? null : req.transition,
    video_count: 1,
    voice_name: req.voice.name,
    voice_rate: req.voice.rate,
    voice_volume: req.voice.volume,
    bgm_type: req.music.type === "none" ? "" : req.music.type,
    bgm_file: req.music.type === "file" ? (req.music.file ?? "") : "",
    bgm_volume: req.music.type === "none" ? 0 : req.music.volume,
    subtitle_enabled: req.subtitles.enabled,
    subtitle_position: req.subtitles.position,
    ...(req.subtitles.fontName && { font_name: req.subtitles.fontName }),
    font_size: req.subtitles.fontSize,
    text_fore_color: req.subtitles.color,
    stroke_color: req.subtitles.strokeColor,
    stroke_width: req.subtitles.strokeWidth,
  };
};

// MPT task states (app/models/const.py).
const MPT_STATE = { FAILED: -1, COMPLETE: 1, PROCESSING: 4 } as const;

export interface RenderTask {
  taskId: string;
  state: "processing" | "complete" | "failed";
  progress: number;
  /** Paths or URLs of rendered files, as MPT reports them. Resolve with downloadUrl(). */
  videos: string[];
  failedStage?: string;
  error?: string;
}

const envelope = <T extends z.ZodType>(data: T) => z.object({ status: z.number(), message: z.string().nullish(), data });
const taskCreatedSchema = envelope(z.object({ task_id: z.string().min(1) }));
const taskStatusSchema = envelope(
  z
    .object({
      task_id: z.string().optional(),
      state: z.number(),
      progress: z.number().default(0),
      videos: z.array(z.string()).nullish(),
      failed_stage: z.string().nullish(),
      error: z.string().nullish(),
    })
    .loose(),
);

export class MoneyPrinterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly options: MoneyPrinterOptions) {
    if (!options.apiKey) throw new Error("MoneyPrinterTurbo api key is required (MPT is unauthenticated without one)");
    this.fetchImpl = options.fetch ?? fetch;
    this.base = options.baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers: { "x-api-key": this.options.apiKey, ...init.headers } });
    } catch (cause) {
      throw new AppError("upstream_error", "Video render service unreachable", undefined, { cause });
    }
    if (response.ok) return response;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string; detail?: unknown };
      message = body.message ?? (typeof body.detail === "string" ? body.detail : message);
    } catch {
      // non-JSON error body; status is enough
    }
    if (response.status === 429) throw new AppError("rate_limited", "Video render queue is full; retry later");
    if (response.status === 400 || response.status === 422) throw new AppError("bad_request", `Video render rejected the request: ${message}`);
    if (response.status === 401 || response.status === 403) throw new AppError("upstream_error", "Video render service rejected our credentials");
    throw new AppError("upstream_error", `Video render service error: ${message}`, { status: response.status });
  }

  /** Queues a render. Returns MPT's task id. */
  async createVideo(input: ReelRenderRequest): Promise<string> {
    const response = await this.request("/api/v1/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toVideoParams(input)),
    });
    const parsed = taskCreatedSchema.safeParse(await response.json());
    if (!parsed.success) throw new AppError("upstream_error", "Unexpected response from video render service");
    return parsed.data.data.task_id;
  }

  async getTask(taskId: string): Promise<RenderTask> {
    const response = await this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    const parsed = taskStatusSchema.safeParse(await response.json());
    if (!parsed.success) throw new AppError("upstream_error", "Unexpected task status from video render service");
    const data = parsed.data.data;
    const state = data.state === MPT_STATE.COMPLETE ? "complete" : data.state === MPT_STATE.FAILED ? "failed" : "processing";
    return {
      taskId,
      state,
      progress: data.progress,
      videos: data.videos ?? [],
      ...(data.failed_stage && { failedStage: data.failed_stage }),
      ...(data.error && { error: data.error }),
    };
  }

  /** Frees MPT's disk once the file is copied to object storage. MPT refuses (409) while a task is busy. */
  async deleteTask(taskId: string): Promise<void> {
    await this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  }

  /**
   * MPT reports outputs as task-relative paths (`tasks/<id>/...`), prefixed with its configured
   * `endpoint` when one is set. Absolute URLs must point at this same service: we never fetch
   * an arbitrary URL taken from a response (SSRF).
   */
  downloadUrl(videoPath: string): string {
    if (/^https?:\/\//i.test(videoPath)) {
      if (new URL(videoPath).origin !== new URL(this.base).origin) {
        throw new AppError("upstream_error", "Render output points at an unexpected host");
      }
      return videoPath;
    }
    const relative = videoPath.replace(/^\/+/, "");
    if (relative.split("/").includes("..")) throw new AppError("upstream_error", "Render output path is not allowed");
    return `${this.base}/api/v1/download/${relative}`;
  }

  /** Streams a rendered file (to be copied into object storage by the worker). */
  async download(videoPath: string): Promise<Response> {
    const url = new URL(this.downloadUrl(videoPath));
    return this.request(`${url.pathname}${url.search}`);
  }

  /** Uploads a brand-owned image or clip (e.g. product photos) for source "local". Returns MPT's response data. */
  async uploadMaterial(file: Blob, filename: string): Promise<unknown> {
    const form = new FormData();
    form.append("file", file, filename);
    const response = await this.request("/api/v1/video_materials", { method: "POST", body: form });
    return ((await response.json()) as { data?: unknown }).data;
  }
}
