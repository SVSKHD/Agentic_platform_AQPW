/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/** Full-jitter exponential backoff: random in [0, min(max, base * 2^attempt)]. */
export const backoffDelay = (attempt: number, { baseMs, maxMs }: BackoffOptions, random = Math.random): number =>
  Math.round(random() * Math.min(maxMs, baseMs * 2 ** attempt));

/** Bounds in-process concurrency. Not distributed: each process has its own limit. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
  }

  /** Waits for a slot; call the returned function exactly once to free it. */
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }
}
