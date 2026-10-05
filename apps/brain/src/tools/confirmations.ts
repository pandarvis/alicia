import type { ConfirmationOutcome, ServerEvent } from "@alicia/protocol";

export type { ConfirmationOutcome };

export interface ConfirmationRequest {
  tool: string;
  /** French question for the card (at most 500 characters). */
  summary: string;
}

/** Where a question belongs: its conversation, and the person's message it answers (the card sits after it). */
export interface ConfirmationWhere {
  conversationId: string;
  messageId: string;
}

/** How long a card waits for an answer. */
export const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;
/**
 * Once approved, the time left to the tool itself. A call of one of our tools may thus last up to the answer's
 * delay plus this budget: the engine's own deadline for a tool call (EngineRequest.toolTimeoutMs).
 */
export const TOOL_RUN_BUDGET_MS = 60_000;
/** Recently settled cards remembered per connection, to tell a late answer how its card ended. */
const SETTLED_MEMORY = 32;

type ConfirmationEvent = Extract<ServerEvent, { type: "confirm_request" | "confirm_result" }>;

export interface BrokerOptions {
  /** False (or a throw) when the connection cannot carry it any more (closed, failing). */
  send(event: ConfirmationEvent): boolean;
  newId(): string;
  now(): number;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  timeoutMs?: number;
}

/**
 * Confirmations of one WebSocket connection (one PC): only the device that started the turn can answer them.
 * Every request settles exactly once (answer, delay, abort or cancelAll) and never rejects, even when the
 * connection cannot send.
 */
export class ConfirmationBroker {
  readonly #options: BrokerOptions;
  readonly #pending = new Map<string, (outcome: ConfirmationOutcome) => void>();
  /** The last settled cards, oldest first: a late answer (stale card, crossed expiry) gets their outcome again. */
  readonly #settled = new Map<string, Extract<ConfirmationEvent, { type: "confirm_result" }>>();

  constructor(options: BrokerOptions) {
    this.#options = options;
  }

  get timeoutMs(): number {
    return this.#options.timeoutMs ?? CONFIRMATION_TIMEOUT_MS;
  }

  ask(where: ConfirmationWhere, request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationOutcome> {
    if (signal.aborted) return Promise.resolve("cancelled");
    const confirmationId = this.#options.newId();
    const { conversationId } = where;
    const timeoutMs = this.timeoutMs;
    return new Promise((resolve) => {
      let cancelTimer: () => void = () => undefined;
      const onAbort = (): void => {
        settle("cancelled");
      };
      const settle = (outcome: ConfirmationOutcome): void => {
        if (!this.#pending.delete(confirmationId)) return;
        cancelTimer();
        signal.removeEventListener("abort", onAbort);
        const result = { type: "confirm_result", conversationId, confirmationId, outcome } as const;
        this.#remember(result);
        this.#trySend(result);
        resolve(outcome);
      };
      this.#pending.set(confirmationId, settle);
      signal.addEventListener("abort", onAbort, { once: true });
      cancelTimer = this.#options.schedule(() => {
        settle("expired");
      }, timeoutMs);
      const sent = this.#trySend({
        type: "confirm_request", conversationId, messageId: where.messageId, confirmationId, tool: request.tool,
        summary: request.summary, expiresAt: new Date(this.#options.now() + timeoutMs).toISOString(),
      });
      // Nobody can see the card: nothing to wait for.
      if (!sent) settle("cancelled");
    });
  }

  /**
   * The person's answer; true when it settled a waiting card. An answer for a card already settled here is no
   * error (a stale card, an answer that crossed the expiry): its outcome is sent again. Unknown: ignored.
   */
  answer(confirmationId: string, approved: boolean): boolean {
    const settle = this.#pending.get(confirmationId);
    if (settle !== undefined) {
      settle(approved ? "approved" : "refused");
      return true;
    }
    const settled = this.#settled.get(confirmationId);
    if (settled !== undefined) this.#trySend(settled);
    return false;
  }

  /** Connection lost: everything still waiting is cancelled (so the tools are refused). */
  cancelAll(): void {
    for (const settle of [...this.#pending.values()]) settle("cancelled");
  }

  #remember(result: Extract<ConfirmationEvent, { type: "confirm_result" }>): void {
    this.#settled.set(result.confirmationId, result);
    for (const oldest of this.#settled.keys()) {
      if (this.#settled.size <= SETTLED_MEMORY) break;
      this.#settled.delete(oldest);
    }
  }

  /** False when the connection could not send (closed, failing). */
  #trySend(event: ConfirmationEvent): boolean {
    try {
      return this.#options.send(event);
    } catch {
      return false;
    }
  }
}
