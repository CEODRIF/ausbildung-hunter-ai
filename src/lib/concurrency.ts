/**
 * Tiny dependency-free concurrency + retry primitives.
 *
 * Used by the AI Search discovery and enrichment pipelines so that
 * parallel page fetches stay bounded (no 429 storms, no memory blow-up)
 * and transient network failures get a fair, capped retry with
 * exponential backoff. Deterministic, side-effect free apart from the
 * timer.
 */

/** Bounded fan-out: at most `limit` tasks in flight at any time. */
export class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("ConcurrencyLimiter limit must be a positive integer.");
    }
  }

  get currentLimit(): number {
    return this.limit;
  }

  /** Run `task` within the budget; resolves with the task's result. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff (base, base*2, base*4, …).
 * `shouldRetry` inspects the RESULT value (callers model failures as
 * values, e.g. discriminated unions) — only what it whitelists is
 * retried; anything else (deliberate blocks, 429s, robots denials) is
 * returned immediately. Never throws for a failed task; the caller gets
 * the final value and decides.
 */
export async function retryWithBackoff<T>(
  task: () => Promise<T>,
  options: {
    shouldRetry: (value: T) => boolean;
    maxAttempts?: number;
    baseDelayMs?: number;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const base = options.baseDelayMs ?? 500;
  let last = await task();
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!options.shouldRetry(last)) return last;
    await sleep(base * 2 ** (attempt - 1));
    last = await task();
  }
  return last;
}
