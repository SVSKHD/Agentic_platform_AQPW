export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. Validate before executing (Phase 2 tool runner). */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: Record<string, unknown>; strict?: boolean };

/** One hop in a model routing chain. Later entries are fallbacks. */
export interface ModelRoute {
  /** Provider name; defaults to the gateway's first provider. */
  provider?: string;
  model: string;
}

/** Who the call is for. brandId must come from the authenticated principal, never from client input. */
export interface RequestContext {
  brandId: string;
  applicationId?: string | null;
  agentId?: string;
  sessionId?: string;
  requestId: string;
}

export interface ChatRequest {
  /** Overrides the gateway default route (e.g. per-agent or per-brand model config). */
  route?: ModelRoute[];
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  temperature?: number;
  maxTokens?: number;
  /** Total deadline across retries and fallbacks. */
  timeoutMs?: number;
  signal?: AbortSignal;
  context: RequestContext;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cost reported by the provider. null when not reported; never estimated from hardcoded prices. */
  costUsd: number | null;
}

export interface ChatResult {
  id: string;
  provider: string;
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: TokenUsage;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "done"; result: ChatResult };

export type ProviderRequest = Omit<ChatRequest, "route" | "context" | "timeoutMs" | "signal"> & { model: string };

/** Text-generation provider. Image, audio and video providers get their own interfaces (spec §4). */
export interface LlmProvider {
  readonly name: string;
  chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult>;
  /** Must end with exactly one `done` event, or throw. */
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

export interface UsageEvent {
  context: RequestContext;
  provider: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  status: "success" | "error";
  errorCode?: string;
}

export interface UsageSink {
  record(event: UsageEvent): Promise<void>;
}

export interface BudgetGuard {
  /** Throws LlmError("budget_exceeded") when the brand is over its limits. */
  check(context: RequestContext): Promise<void>;
}
