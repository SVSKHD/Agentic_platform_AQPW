import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@uap/llm-gateway";
import { buildRequestBody, OpenRouterProvider, sseData } from "../src/index.js";

// No network: every test injects a fetch that returns canned OpenRouter responses.
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const capture = (response: () => Response) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { requests, provider: new OpenRouterProvider({ apiKey: "sk-or-test", baseUrl: "https://openrouter.test/api/v1/", appName: "UAP", fetch: fetchImpl }) };
};

const signal = () => new AbortController().signal;
const baseRequest = { model: "vendor/model-x", messages: [{ role: "user" as const, content: "hi" }] };

describe("buildRequestBody", () => {
  it("maps messages, tools, tool choice and structured output to the OpenAI-compatible wire format", () => {
    const body = buildRequestBody(
      {
        model: "m",
        messages: [
          { role: "system", content: "s" },
          { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "search", arguments: '{"q":"x"}' }] },
          { role: "tool", toolCallId: "c1", content: "result" },
        ],
        tools: [{ name: "search", description: "d", parameters: { type: "object" } }],
        toolChoice: { name: "search" },
        responseFormat: { type: "json_schema", name: "out", schema: { type: "object" } },
        maxTokens: 50,
      },
      false,
    );
    expect(body).toMatchObject({
      model: "m",
      stream: false,
      usage: { include: true },
      max_tokens: 50,
      tool_choice: { type: "function", function: { name: "search" } },
      response_format: { type: "json_schema", json_schema: { name: "out", strict: true } },
    });
    expect(body.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }] });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
  });
});

describe("OpenRouterProvider.chat", () => {
  it("sends auth and attribution headers and parses content, tool calls and cost", async () => {
    const { provider, requests } = capture(() =>
      json(200, {
        id: "gen-1",
        model: "vendor/model-x",
        choices: [{ message: { content: "hello", tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.00042 },
      }),
    );
    const res = await provider.chat(baseRequest, signal());
    expect(requests[0]?.url).toBe("https://openrouter.test/api/v1/chat/completions");
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    expect(headers["X-Title"]).toBe("UAP");
    expect(res).toMatchObject({ id: "gen-1", provider: "openrouter", content: "hello", finishReason: "tool_calls", usage: { totalTokens: 14, costUsd: 0.00042 } });
    expect(res.toolCalls).toEqual([{ id: "t1", name: "lookup", arguments: "{}" }]);
  });

  it("normalizes HTTP errors, including Retry-After", async () => {
    const cases: [number, string][] = [
      [401, "auth"],
      [402, "quota_exceeded"],
      [400, "bad_request"],
      [503, "provider_unavailable"],
    ];
    for (const [status, code] of cases) {
      const { provider } = capture(() => json(status, { error: { code: status, message: "nope" } }));
      await expect(provider.chat(baseRequest, signal())).rejects.toMatchObject({ code, status });
    }
    const { provider } = capture(() => json(429, { error: { message: "slow down" } }, { "retry-after": "2" }));
    await expect(provider.chat(baseRequest, signal())).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 2000, retryable: true });
  });

  it("treats an error object in a 200 body and content filtering as failures", async () => {
    const errored = capture(() => json(200, { error: { code: 502, message: "upstream" } }));
    await expect(errored.provider.chat(baseRequest, signal())).rejects.toMatchObject({ code: "provider_unavailable" });
    const filtered = capture(() => json(200, { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }));
    await expect(filtered.provider.chat(baseRequest, signal())).rejects.toMatchObject({ code: "content_filtered" });
  });
});

describe("OpenRouterProvider.stream", () => {
  it("parses SSE across chunk boundaries, skips comments, assembles tool calls and reads final usage", async () => {
    const events = [
      ": OPENROUTER PROCESSING\n\n",
      'data: {"id":"gen-2","model":"vendor/model-x","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"look","arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n',
      '\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"cost":0.0001}}\n\n',
      "data: [DONE]\n\n",
    ];
    const { provider } = capture(() => sse(events));
    const out: StreamEvent[] = [];
    for await (const event of provider.stream(baseRequest, signal())) out.push(event);

    const text = out.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe("Hello");
    const done = out.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.result).toMatchObject({ id: "gen-2", content: "Hello", finishReason: "tool_calls", usage: { totalTokens: 8, costUsd: 0.0001 } });
    expect(done.result.toolCalls).toEqual([{ id: "t1", name: "lookup", arguments: '{"q":1}' }]);
  });

  it("surfaces a mid-stream error event", async () => {
    const { provider } = capture(() => sse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"error":{"code":503,"message":"overloaded"}}\n\n']));
    await expect(
      (async () => {
        for await (const _ of provider.stream(baseRequest, signal())) void _;
      })(),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("sseData", () => {
  it("handles CRLF delimiters and a trailing event without a blank line", async () => {
    const out: string[] = [];
    for await (const data of sseData(sse(["data: one\r\n\r\ndata: two"]).body!)) out.push(data);
    expect(out).toEqual(["one", "two"]);
  });
});
