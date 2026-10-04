import { isIPv6 } from "node:net";
import type { Clock } from "../clock.ts";

const IPV4_MAPPED = /^::ffff:\d+\.\d+\.\d+\.\d+$/i;

/** The 16-bit groups of one side of "::" (a dotted IPv4 tail counts as two groups). */
function groupsOf(part: string): string[] {
  if (part === "") return [];
  return part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group]));
}

/**
 * The key under which an address's failures are counted. An IPv6 host usually controls a whole /64
 * (it can pick any address in it at will): IPv6 addresses are keyed by their /64 prefix.
 * IPv4 and IPv4-mapped addresses are kept as they are.
 */
export function addressKey(ip: string): string {
  if (!isIPv6(ip) || IPV4_MAPPED.test(ip)) return ip;
  const address = ip.split("%")[0] ?? ip;
  const halves = address.split("::");
  const head = groupsOf(halves[0] ?? "");
  const tail = groupsOf(halves[1] ?? "");
  const groups =
    halves.length === 2
      ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail]
      : head;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

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

  /** A success clears the key: someone who finally got it right starts again from zero. */
  succeed(key: string): void {
    this.#failures.delete(key);
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
