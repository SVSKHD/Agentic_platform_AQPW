import { backoffDelay, Semaphore, sleep, type Logger } from "@uap/core";
import { z, type ZodType } from "zod";
import { LlmError } from "./errors.js";
import type {
  BudgetGuard,
  ChatRequest,
  ChatResult,
  LlmProvider,
  ModelRoute,
  ProviderRequest,
  RequestContext,
  StreamEvent,
  TokenUsage,
  UsageSink,
} from "./types.js";

export interface GatewayOptions {
  /** Ordered; the first is the default provider for routes that do not name one. */
  providers: LlmProvider[];
  /** Used when a request has no route. Comes from config (DEFAULT_LLM_MODEL), never hardcoded. */
  defaultRoute?: ModelRoute[];
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  retryBackoff?: { baseMs: number; maxMs: number };
  usage?: UsageSink;
  budget?: BudgetGuard;
  logger: Logger;
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null };

/**
 * Single entry point for every LLM call (spec §4). Handles routing, provider fallback,
 * retries with backoff, deadlines, cancellation, concurrency, budgets and usage recording.
 * Agents and chat never talk to a provider directly.
 */
export class LlmGateway {
  private readonly providers: Map<string, LlmProvider>;
  private readonly semaphore: Semaphore;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly log: Logger;

  constructor(private readonly options: GatewayOptions) {
    this.providers = new Map(options.providers.map((p) => [p.name, p]));
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.backoff = options.retryBackoff ?? { baseMs: 250, maxMs: 8_000 };
    this.log = options.logger.child({ component: "llm-gateway" });
  }

  get configured(): boolean {
    return this.options.providers.length > 0 && Boolean(this.options.defaultRoute?.length);
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const { routes, signal } = await this.prepare(request);
    let lastError: LlmError | undefined;
    for (const { provider, model } of routes) {
      for (let attempt = 0; ; attempt += 1) {
        const started = Date.now();
        try {
          const result = await this.semaphore.run(() => provider.chat(this.providerRequest(request, model), signal));
          await this.recordUsage(request.context, provider.name, result.model, result.usage, started, "success");
          return result;
        } catch (raw) {
          const err = this.normalize(raw, provider.name, request.signal, signal);
          await this.recordUsage(request.context, provider.name, model, ZERO_USAGE, started, "error", err.code);
          lastError = err;
          if (err.code === "timeout" || err.code === "cancelled") throw err;
          if (err.retryable && attempt < this.options.maxRetries) {
            const delay = err.retryAfterMs ?? backoffDelay(attempt, this.backoff);
            this.log.warn({ provider: provider.name, model, attempt: attempt + 1, code: err.code, delay, requestId: request.context.requestId }, "LLM call failed; retrying");
            await sleep(delay, signal).catch(() => {
              throw this.normalize(signal.reason, provider.name, request.signal, signal);
            });
            continue;
          }
          if (err.fallbackable) {
            this.log.warn({ provider: provider.name, model, code: err.code, requestId: request.context.requestId }, "LLM route exhausted; falling back");
            break;
          }
          throw err;
        }
      }
    }
    throw lastError ?? new LlmError("not_configured", "No usable model route");
  }

  /**
   * Streams one completion. Retries and fallback only happen before the first event is
   * emitted: once tokens reach the caller, a failure is surfaced, never silently replayed.
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { routes, signal } = await this.prepare(request);
    const release = await this.semaphore.acquire();
    try {
      let lastError: LlmError | undefined;
      for (const { provider, model } of routes) {
        for (let attempt = 0; ; attempt += 1) {
          const started = Date.now();
          let emitted = false;
          try {
            for await (const event of provider.stream(this.providerRequest(request, model), signal)) {
              emitted = true;
              if (event.type === "done") {
                await this.recordUsage(request.context, provider.name, event.result.model, event.result.usage, started, "success");
              }
              yield event;
              if (event.type === "done") return;
            }
            throw new LlmError("provider_unavailable", "Stream ended without completion", { provider: provider.name });
          } catch (raw) {
            const err = this.normalize(raw, provider.name, request.signal, signal);
            await this.recordUsage(request.context, provider.name, model, ZERO_USAGE, started, "error", err.code);
            lastError = err;
            if (emitted || err.code === "timeout" || err.code === "cancelled") throw err;
            if (err.retryable && attempt < this.options.maxRetries) {
              await sleep(err.retryAfterMs ?? backoffDelay(attempt, this.backoff), signal).catch(() => {
                throw this.normalize(signal.reason, provider.name, request.signal, signal);
              });
              continue;
            }
            if (err.fallbackable) break;
            throw err;
          }
        }
      }
      throw lastError ?? new LlmError("not_configured", "No usable model route");
    } finally {
      release();
    }
  }

  /** Structured output: asks for JSON matching the schema and validates the reply with Zod. */
  async chatJson<T>(request: ChatRequest, schema: ZodType<T>, name: string): Promise<{ data: T; result: ChatResult }> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const result = await this.chat({ ...request, responseFormat: { type: "json_schema", name, schema: jsonSchema, strict: true } });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content ?? "");
    } catch (cause) {
      throw new LlmError("invalid_output", "Model did not return valid JSON", { cause, provider: result.provider });
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new LlmError("invalid_output", "Model output did not match the expected schema", { cause: validated.error, provider: result.provider });
    }
    return { data: validated.data, result };
  }

  private async prepare(request: ChatRequest) {
    const routeList = request.route?.length ? request.route : this.options.defaultRoute;
    if (!routeList?.length) throw new LlmError("not_configured", "No model configured: set DEFAULT_LLM_MODEL or pass a route");
    const routes = routeList.map((route) => {
      const provider = route.provider ? this.providers.get(route.provider) : this.options.providers[0];
      if (!provider) throw new LlmError("not_configured", `LLM provider '${route.provider ?? "default"}' is not configured`);
      return { provider, model: route.model };
    });

    if (this.options.budget) await this.options.budget.check(request.context);

    const deadline = AbortSignal.timeout(request.timeoutMs ?? this.options.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    return { routes, signal };
  }

  private providerRequest(request: ChatRequest, model: string): ProviderRequest {
    const { route: _route, context: _context, timeoutMs: _timeout, signal: _signal, ...rest } = request;
    return { ...rest, model };
  }

  private normalize(raw: unknown, provider: string, callerSignal: AbortSignal | undefined, signal: AbortSignal): LlmError {
    if (raw instanceof LlmError) return raw;
    if (callerSignal?.aborted) return new LlmError("cancelled", "Request cancelled", { cause: raw, provider });
    if (signal.aborted) return new LlmError("timeout", "LLM request timed out", { cause: raw, provider });
    return new LlmError("unknown", raw instanceof Error ? raw.message : "Unknown LLM error", { cause: raw, provider });
  }

  private async recordUsage(
    context: RequestContext,
    provider: string,
    model: string,
    usage: TokenUsage,
    started: number,
    status: "success" | "error",
    errorCode?: string,
  ): Promise<void> {
    if (!this.options.usage) return;
    try {
      await this.options.usage.record({ context, provider, model, usage, latencyMs: Date.now() - started, status, ...(errorCode && { errorCode }) });
    } catch (err) {
      // Usage loss weakens budget enforcement, so this is an error, but it must not fail the user's request.
      this.log.error({ err, requestId: context.requestId }, "Failed to record LLM usage");
    }
  }
}
