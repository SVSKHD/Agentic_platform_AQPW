import {
  LlmError,
  type ChatMessage,
  type ChatResult,
  type LlmErrorCode,
  type LlmProvider,
  type ProviderRequest,
  type StreamEvent,
  type ToolCall,
  type TokenUsage,
} from "@uap/llm-gateway";

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  /** Sent as HTTP-Referer / X-Title for OpenRouter app attribution. */
  appUrl?: string;
  appName?: string;
  fetch?: typeof fetch;
}

// ---- Wire types (subset of the OpenAI-compatible schema OpenRouter uses) ----
interface WireToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}
interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}
interface WireError {
  code?: number | string;
  message?: string;
}
interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  delta?: { content?: string | null; tool_calls?: WireToolCall[] };
  finish_reason?: string | null;
}
interface WireResponse {
  id?: string;
  model?: string;
  choices?: WireChoice[];
  usage?: WireUsage;
  error?: WireError;
}

const PROVIDER = "openrouter";

const toWireMessage = (message: ChatMessage) => {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
};

export const buildRequestBody = (request: ProviderRequest, stream: boolean) => ({
  model: request.model,
  messages: request.messages.map(toWireMessage),
  stream,
  // Ask OpenRouter to report token counts and cost so we never estimate from hardcoded prices.
  usage: { include: true },
  ...(request.tools?.length && {
    tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
  }),
  ...(request.toolChoice && {
    tool_choice: typeof request.toolChoice === "string" ? request.toolChoice : { type: "function", function: { name: request.toolChoice.name } },
  }),
  ...(request.responseFormat &&
    request.responseFormat.type !== "text" && {
      response_format:
        request.responseFormat.type === "json_schema"
          ? { type: "json_schema", json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: request.responseFormat.strict ?? true } }
          : { type: "json_object" },
    }),
  ...(request.temperature !== undefined && { temperature: request.temperature }),
  ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
});

const toUsage = (usage?: WireUsage): TokenUsage => {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    costUsd: typeof usage?.cost === "number" ? usage.cost : null,
  };
};

const codeForStatus = (status: number): LlmErrorCode => {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota_exceeded";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  if (status >= 500) return "provider_unavailable";
  return "unknown";
};

const retryAfterMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(date - Date.now(), 30_000));
};

const errorFromBody = (error: WireError, fallbackStatus?: number): LlmError => {
  const status = typeof error.code === "number" ? error.code : fallbackStatus;
  const code = status ? codeForStatus(status) : "unknown";
  return new LlmError(code, `OpenRouter: ${error.message ?? "request failed"}`, { provider: PROVIDER, ...(status && { status }) });
};

export class OpenRouterProvider implements LlmProvider {
  readonly name = PROVIDER;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        ...(this.options.appUrl && { "HTTP-Referer": this.options.appUrl }),
        ...(this.options.appName && { "X-Title": this.options.appName }),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = (await response.json()) as WireResponse;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Non-JSON error body; the status code is enough to classify it.
      }
      throw new LlmError(codeForStatus(response.status), `OpenRouter: ${message}`, {
        provider: PROVIDER,
        status: response.status,
        ...(retryAfterMs(response.headers.get("retry-after")) !== undefined && { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) as number }),
      });
    }
    return response;
  }

  async chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult> {
    const response = await this.post(buildRequestBody(request, false), signal);
    const body = (await response.json()) as WireResponse;
    if (body.error) throw errorFromBody(body.error, response.status);
    const choice = body.choices?.[0];
    if (!choice) throw new LlmError("provider_unavailable", "OpenRouter returned no choices", { provider: PROVIDER });
    if (choice.finish_reason === "content_filter") throw new LlmError("content_filtered", "Response blocked by content filter", { provider: PROVIDER });

    const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((call, i) => ({
      id: call.id ?? `call_${i}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "",
    }));
    return {
      id: body.id ?? "",
      provider: PROVIDER,
      model: body.model ?? request.model,
      content: choice.message?.content ?? null,
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      usage: toUsage(body.usage),
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.post(buildRequestBody(request, true), signal);
    if (!response.body) throw new LlmError("provider_unavailable", "OpenRouter returned no stream body", { provider: PROVIDER });

    let id = "";
    let model = request.model;
    let content = "";
    let finishReason: string | null = null;
    let usage: WireUsage | undefined;
    const calls = new Map<number, ToolCall>();

    for await (const data of sseData(response.body)) {
      if (data === "[DONE]") break;
      let chunk: WireResponse;
      try {
        chunk = JSON.parse(data) as WireResponse;
      } catch (cause) {
        throw new LlmError("provider_unavailable", "OpenRouter sent malformed stream data", { provider: PROVIDER, cause });
      }
      if (chunk.error) throw errorFromBody(chunk.error);
      id ||= chunk.id ?? "";
      model = chunk.model ?? model;
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        yield { type: "text", delta: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name += call.function.name;
        if (call.function?.arguments) existing.arguments += call.function.arguments;
        calls.set(index, existing);
        yield {
          type: "tool_call",
          index,
          ...(call.id && { id: call.id }),
          ...(call.function?.name && { name: call.function.name }),
          ...(call.function?.arguments && { argumentsDelta: call.function.arguments }),
        };
      }
    }

    if (finishReason === "content_filter") throw new LlmError("content_filtered", "Response blocked by content filter", { provider: PROVIDER });
    yield {
      type: "done",
      result: {
        id,
        provider: PROVIDER,
        model,
        content: content || null,
        toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
        finishReason,
        usage: toUsage(usage),
      },
    };
  }
}

/** Yields the `data:` payload of each SSE event. Comment lines (": OPENROUTER PROCESSING") are skipped. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trimStart();
}
