import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLogger } from "@uap/core";
import {
  createBudgetGuard,
  LlmError,
  LlmGateway,
  type ChatRequest,
  type ChatResult,
  type GatewayOptions,
  type LlmProvider,
  type ProviderRequest,
  type StreamEvent,
  type UsageEvent,
} from "../src/index.js";

const logger = createLogger({ level: "silent" });
const context = { brandId: "brandA", requestId: "req-1" };
const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ messages: [{ role: "user", content: "hi" }], context, ...extra });

const result = (provider: string, model: string, content = "ok"): ChatResult => ({
  id: "r1",
  provider,
  model,
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: 0.0001 },
});

type Step = (req: ProviderRequest, signal: AbortSignal) => Promise<ChatResult>;

/** Provider whose responses are scripted per call. */
class ScriptedProvider implements LlmProvider {
  calls: ProviderRequest[] = [];
  constructor(
    readonly name: string,
    private readonly steps: Step[],
  ) {}
  async chat(req: ProviderRequest, signal: AbortSignal) {
    this.calls.push(req);
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)];
    if (!step) throw new Error("no step");
    return step(req, signal);
  }
  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const final = await this.chat(req, signal);
    for (const word of (final.content ?? "").split(" ")) yield { type: "text", delta: word };
    yield { type: "done", result: final };
  }
}

const ok = (provider: string): Step => async (req) => result(provider, req.model);
const fail = (code: ConstructorParameters<typeof LlmError>[0], extra: { retryAfterMs?: number } = {}): Step => async () => {
  throw new LlmError(code, code, extra);
};

const gateway = (providers: LlmProvider[], extra: Partial<GatewayOptions> = {}) => {
  const usage: UsageEvent[] = [];
  const instance = new LlmGateway({
    providers,
    defaultRoute: [{ model: "model-a" }],
    timeoutMs: 1_000,
    maxRetries: 2,
    maxConcurrency: 4,
    retryBackoff: { baseMs: 1, maxMs: 2 },
    usage: { record: async (event) => void usage.push(event) },
    logger,
    ...extra,
  });
  return { instance, usage };
};

describe("LlmGateway.chat", () => {
  it("refuses to run without a configured model instead of guessing one", async () => {
    const { instance } = gateway([new ScriptedProvider("p", [ok("p")])], { defaultRoute: [] });
    await expect(instance.chat(request())).rejects.toMatchObject({ code: "not_configured" });
  });

  it("uses the default route and records usage with provider-reported cost", async () => {
    const provider = new ScriptedProvider("p", [ok("p")]);
    const { instance, usage } = gateway([provider]);
    const res = await instance.chat(request());
    expect(res.model).toBe("model-a");
    expect(provider.calls[0]?.model).toBe("model-a");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ status: "success", provider: "p", usage: { totalTokens: 5, costUsd: 0.0001 }, context });
  });

  it("retries retryable errors with backoff, recording each failed attempt", async () => {
    const provider = new ScriptedProvider("p", [fail("rate_limited"), fail("provider_unavailable"), ok("p")]);
    const { instance, usage } = gateway([provider]);
    await expect(instance.chat(request())).resolves.toMatchObject({ content: "ok" });
    expect(provider.calls).toHaveLength(3);
    expect(usage.map((u) => u.status)).toEqual(["error", "error", "success"]);
  });

  it("does not retry non-retryable errors", async () => {
    const provider = new ScriptedProvider("p", [fail("bad_request"), ok("p")]);
    const { instance } = gateway([provider]);
    await expect(instance.chat(request())).rejects.toMatchObject({ code: "bad_request" });
    expect(provider.calls).toHaveLength(1);
  });

  it("falls back to the next route once retries are exhausted", async () => {
    const primary = new ScriptedProvider("primary", [fail("provider_unavailable")]);
    const backup = new ScriptedProvider("backup", [ok("backup")]);
    const { instance } = gateway([primary, backup], { maxRetries: 1 });
    const res = await instance.chat(request({ route: [{ model: "a" }, { provider: "backup", model: "b" }] }));
    expect(primary.calls).toHaveLength(2);
    expect(res).toMatchObject({ provider: "backup", model: "b" });
  });

  it("enforces its deadline and reports a timeout", async () => {
    const slow: Step = (_req, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const { instance } = gateway([new ScriptedProvider("p", [slow])]);
    await expect(instance.chat(request({ timeoutMs: 20 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("propagates caller cancellation without retrying", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider("p", [
      (_req, signal) => {
        setTimeout(() => controller.abort(), 5);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    ]);
    const { instance } = gateway([provider]);
    await expect(instance.chat(request({ signal: controller.signal }))).rejects.toMatchObject({ code: "cancelled" });
    expect(provider.calls).toHaveLength(1);
  });

  it("caps in-flight provider calls at maxConcurrency", async () => {
    let active = 0;
    let peak = 0;
    const step: Step = async (req) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return result("p", req.model);
    };
    const { instance } = gateway([new ScriptedProvider("p", [step])], { maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => instance.chat(request())));
    expect(peak).toBe(2);
  });

  it("does not fail the request when usage recording fails", async () => {
    const { instance } = gateway([new ScriptedProvider("p", [ok("p")])], { usage: { record: vi.fn().mockRejectedValue(new Error("db down")) } });
    await expect(instance.chat(request())).resolves.toMatchObject({ content: "ok" });
  });
});

describe("LlmGateway.chatJson", () => {
  const schema = z.object({ title: z.string(), keywords: z.array(z.string()) });

  it("requests json_schema output and validates the reply", async () => {
    const provider = new ScriptedProvider("p", [async (req) => result("p", req.model, JSON.stringify({ title: "Hard water", keywords: ["softener"] }))]);
    const { instance } = gateway([provider]);
    const { data } = await instance.chatJson(request(), schema, "blog_outline");
    expect(data.title).toBe("Hard water");
    expect(provider.calls[0]?.responseFormat).toMatchObject({ type: "json_schema", name: "blog_outline", strict: true });
  });

  it("rejects malformed or off-schema output", async () => {
    const notJson = gateway([new ScriptedProvider("p", [async (req) => result("p", req.model, "not json")])]);
    await expect(notJson.instance.chatJson(request(), schema, "x")).rejects.toMatchObject({ code: "invalid_output" });
    const wrong = gateway([new ScriptedProvider("p", [async (req) => result("p", req.model, JSON.stringify({ title: 1 }))])]);
    await expect(wrong.instance.chatJson(request(), schema, "x")).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("LlmGateway.stream", () => {
  it("streams deltas and records usage on completion", async () => {
    const { instance, usage } = gateway([new ScriptedProvider("p", [async (req) => result("p", req.model, "hello there")])]);
    const events: StreamEvent[] = [];
    for await (const event of instance.stream(request())) events.push(event);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual(["hello", "there"]);
    expect(events.at(-1)?.type).toBe("done");
    expect(usage.at(-1)?.status).toBe("success");
  });

  it("retries before the first token but never after tokens were emitted", async () => {
    const before = new ScriptedProvider("p", [fail("provider_unavailable"), ok("p")]);
    const g1 = gateway([before]);
    const events: StreamEvent[] = [];
    for await (const event of g1.instance.stream(request())) events.push(event);
    expect(before.calls).toHaveLength(2);

    const midStream: LlmProvider = {
      name: "mid",
      chat: vi.fn(),
      async *stream() {
        yield { type: "text", delta: "partial" };
        throw new LlmError("provider_unavailable", "dropped");
      },
    };
    const g2 = gateway([midStream]);
    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of g2.instance.stream(request())) seen.push(event);
      })(),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(seen).toHaveLength(1);
  });
});

describe("createBudgetGuard", () => {
  const now = () => new Date("2026-10-25T12:00:00Z");

  it("allows brands without limits and blocks exhausted daily/monthly budgets", async () => {
    const totalsSince = vi.fn(async (_brand: string, since: Date) =>
      since.getUTCDate() === 25 ? { totalTokens: 900, costUsd: 0.5 } : { totalTokens: 5_000, costUsd: 3 },
    );
    await expect(createBudgetGuard({ getBudget: async () => null, totalsSince }, now).check(context)).resolves.toBeUndefined();
    await expect(createBudgetGuard({ getBudget: async () => ({ dailyTokenLimit: 1_000 }), totalsSince }, now).check(context)).resolves.toBeUndefined();
    await expect(createBudgetGuard({ getBudget: async () => ({ dailyTokenLimit: 800 }), totalsSince }, now).check(context)).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await expect(createBudgetGuard({ getBudget: async () => ({ monthlyCostLimitUsd: 2 }), totalsSince }, now).check(context)).rejects.toThrow(/monthly cost/);
  });

  it("is enforced by the gateway before any provider call", async () => {
    const provider = new ScriptedProvider("p", [ok("p")]);
    const budget = createBudgetGuard({ getBudget: async () => ({ dailyTokenLimit: 0 }), totalsSince: async () => ({ totalTokens: 0, costUsd: 0 }) });
    const { instance } = gateway([provider], { budget });
    await expect(instance.chat(request())).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(provider.calls).toHaveLength(0);
  });
});
