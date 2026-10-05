import type { ConfirmationOutcome, ServerEvent } from "@alicia/protocol";

export type { ConfirmationOutcome };

export interface ConfirmationRequest {
  tool: string;
  /** French question for the card (at most 500 characters). */
  summary: string;
}

export const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;

type ConfirmationEvent = Extract<ServerEvent, { type: "confirm_request" | "confirm_result" }>;

export interface BrokerOptions {
  send(event: ConfirmationEvent): void;
  newId(): string;
  now(): number;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  timeoutMs?: number;
}

/**
 * Confirmations of one WebSocket connection (one PC): only the device that started the turn can answer them.
 * Every request settles exactly once (answer, delay, abort or cancelAll) and never rejects.
 */
export class ConfirmationBroker {
  readonly #options: BrokerOptions;
  readonly #pending = new Map<string, (outcome: ConfirmationOutcome) => void>();

  constructor(options: BrokerOptions) {
    this.#options = options;
  }

  ask(conversationId: string, request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationOutcome> {
    if (signal.aborted) return Promise.resolve("cancelled");
    const confirmationId = this.#options.newId();
    const timeoutMs = this.#options.timeoutMs ?? CONFIRMATION_TIMEOUT_MS;
    return new Promise((resolve) => {
      let cancelTimer: () => void = () => undefined;
      const onAbort = (): void => {
        settle("cancelled");
      };
      const settle = (outcome: ConfirmationOutcome): void => {
        if (!this.#pending.delete(confirmationId)) return;
        cancelTimer();
        signal.removeEventListener("abort", onAbort);
        this.#options.send({ type: "confirm_result", conversationId, confirmationId, outcome });
        resolve(outcome);
      };
      this.#pending.set(confirmationId, settle);
      signal.addEventListener("abort", onAbort, { once: true });
      cancelTimer = this.#options.schedule(() => {
        settle("expired");
      }, timeoutMs);
      this.#options.send({
        type: "confirm_request", conversationId, confirmationId, tool: request.tool, summary: request.summary,
        expiresAt: new Date(this.#options.now() + timeoutMs).toISOString(),
      });
    });
  }

  /** The person's answer; false when unknown here (another device, already settled, expired). */
  answer(confirmationId: string, approved: boolean): boolean {
    const settle = this.#pending.get(confirmationId);
    if (settle === undefined) return false;
    settle(approved ? "approved" : "refused");
    return true;
  }

  /** Connection lost: everything still waiting is cancelled (so the tools are refused). */
  cancelAll(): void {
    for (const settle of [...this.#pending.values()]) settle("cancelled");
  }
}
