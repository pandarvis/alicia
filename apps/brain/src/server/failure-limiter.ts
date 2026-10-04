import type { Clock } from "../clock.ts";

export interface FailureLimiterOptions {
  clock: Clock;
  /** Failures older than this are forgotten. */
  windowMs: number;
  /** From this many failures within the window, the key is blocked. */
  maxFailures: number;
  /** Keys tracked at most (the one that failed least recently is dropped first): a flood of addresses cannot grow memory. */
  maxKeys: number;
}

/** Counts recent failures per key (an IP address) and blocks a key that failed too often. */
export class FailureLimiter {
  readonly #options: FailureLimiterOptions;
  /** Insertion order = least recently failed first. */
  readonly #failures = new Map<string, number[]>();

  constructor(options: FailureLimiterOptions) {
    this.#options = options;
  }

  blocked(key: string): boolean {
    return this.#recent(key).length >= this.#options.maxFailures;
  }

  fail(key: string): void {
    const recent = this.#recent(key);
    recent.push(this.#options.clock());
    this.#failures.delete(key);
    this.#failures.set(key, recent);
    while (this.#failures.size > this.#options.maxKeys) {
      const oldest = this.#failures.keys().next();
      if (oldest.done === true) break;
      this.#failures.delete(oldest.value);
    }
  }

  /** The key's failures still inside the window (expired ones are dropped on the way). */
  #recent(key: string): number[] {
    const now = this.#options.clock();
    const recent = (this.#failures.get(key) ?? []).filter((t) => now - t < this.#options.windowMs);
    if (recent.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, recent);
    return recent;
  }
}
