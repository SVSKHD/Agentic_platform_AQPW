import { describe, expect, it } from "vitest";
import { MoneyPrinterClient, toVideoParams, type ReelRenderRequest } from "../src/index.js";

// No network: responses mirror MPT's documented envelopes ({status, message, data}).
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const capture = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { calls, client: new MoneyPrinterClient({ baseUrl: "http://moneyprinter:8080/", apiKey: "mpt-secret", fetch: fetchImpl }) };
};

const request: ReelRenderRequest = {
  subject: "Why hard water damages your skin",
  script: "Hard water leaves minerals on your skin and hair. A softener removes calcium and magnesium before they reach your tap.",
  searchTerms: ["hard water", "water softener", "shower"],
  voice: { name: "en-IN-NeerjaNeural-Female" },
};

describe("toVideoParams", () => {
  it("always sends our own script and maps to MPT VideoParams", () => {
    const params = toVideoParams(request);
    expect(params).toMatchObject({
      video_subject: request.subject,
      video_script: request.script,
      video_terms: ["hard water", "water softener", "shower"],
      video_aspect: "9:16",
      video_source: "pexels",
      video_count: 1,
      voice_name: "en-IN-NeerjaNeural-Female",
      subtitle_enabled: true,
      bgm_type: "",
      bgm_volume: 0,
      video_transition_mode: "FadeIn",
    });
  });

  it("refuses a request without a script, so MPT never writes one with its own LLM", () => {
    expect(() => toVideoParams({ ...request, script: "" })).toThrow();
  });

  it("requires uploaded materials for the local source", () => {
    expect(() => toVideoParams({ ...request, source: "local" })).toThrow(/at least one uploaded material/);
    expect(toVideoParams({ ...request, source: "local", materials: [{ url: "resource/videos/product-1.jpg" }] }).video_materials).toEqual([
      { provider: "local", url: "resource/videos/product-1.jpg", duration: 0 },
    ]);
  });
});

describe("MoneyPrinterClient", () => {
  it("requires an api key because MPT is unauthenticated without one", () => {
    expect(() => new MoneyPrinterClient({ baseUrl: "http://x", apiKey: "" })).toThrow(/api key is required/);
  });

  it("creates a render with x-api-key and returns the task id", async () => {
    const { client, calls } = capture(() => json(200, { status: 200, message: "success", data: { task_id: "6c85c8cc" } }));
    expect(await client.createVideo(request)).toBe("6c85c8cc");
    expect(calls[0]?.url).toBe("http://moneyprinter:8080/api/v1/videos");
    expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("mpt-secret");
  });

  it("maps MPT task states (4 processing, 1 complete, -1 failed)", async () => {
    const states = [
      { state: 4, progress: 40 },
      { state: 1, progress: 100, videos: ["tasks/6c85c8cc/final-1.mp4"] },
      { state: -1, progress: 30, failed_stage: "audio", error: "TTS request timed out" },
    ];
    for (const data of states) {
      const { client } = capture(() => json(200, { status: 200, message: "success", data }));
      const task = await client.getTask("6c85c8cc");
      if (data.state === 4) expect(task).toMatchObject({ state: "processing", progress: 40, videos: [] });
      if (data.state === 1) expect(task).toMatchObject({ state: "complete", videos: ["tasks/6c85c8cc/final-1.mp4"] });
      if (data.state === -1) expect(task).toMatchObject({ state: "failed", failedStage: "audio", error: "TTS request timed out" });
    }
  });

  it("normalizes errors: full queue is retryable, validation is not", async () => {
    await expect(capture(() => json(429, { message: "queue full" })).client.createVideo(request)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(capture(() => json(400, { message: "bad aspect" })).client.createVideo(request)).rejects.toMatchObject({ code: "bad_request" });
    await expect(capture(() => json(401, { message: "invalid API key" })).client.getTask("x")).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("resolves output paths only against the render service itself (no SSRF)", () => {
    const { client } = capture(() => json(200, {}));
    expect(client.downloadUrl("tasks/6c85c8cc/final-1.mp4")).toBe("http://moneyprinter:8080/api/v1/download/tasks/6c85c8cc/final-1.mp4");
    expect(client.downloadUrl("http://moneyprinter:8080/api/v1/download/tasks/a/final-1.mp4")).toContain("moneyprinter:8080");
    expect(() => client.downloadUrl("http://169.254.169.254/latest/meta-data")).toThrow(/unexpected host/);
    expect(() => client.downloadUrl("tasks/../../etc/passwd")).toThrow(/not allowed/);
  });

  it("downloads through the same authenticated client", async () => {
    const { client, calls } = capture(() => new Response("mp4-bytes", { status: 200 }));
    const response = await client.download("tasks/6c85c8cc/final-1.mp4");
    expect(await response.text()).toBe("mp4-bytes");
    expect(calls[0]?.url).toBe("http://moneyprinter:8080/api/v1/download/tasks/6c85c8cc/final-1.mp4");
    expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("mpt-secret");
  });
});
