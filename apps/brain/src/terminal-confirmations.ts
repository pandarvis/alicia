import type { ConfirmationOutcome } from "@alicia/protocol";

export interface TerminalPorts {
  /** Asks a question on the terminal; rejects when `signal` aborts or the prompt closes. */
  ask(question: string, signal: AbortSignal): Promise<string>;
  /** Sends the person's answer to the brain. */
  answer(confirmationId: string, approved: boolean): void;
  print(line: string): void;
}

/** How a card that ran nothing ended, as the terminal says it. */
const OUTCOME_LABELS: Readonly<Record<Exclude<ConfirmationOutcome, "approved">, string>> = {
  refused: "refusé",
  expired: "expiré",
  cancelled: "annulé",
};

interface Card {
  confirmationId: string;
  summary: string;
  controller: AbortController;
}

const YES = /^o(ui)?$/i;

/**
 * Confirmation cards in the terminal (command `chat`): one question at a time, in order. A card settled
 * elsewhere (expired, turn over) stops being asked at once, so the terminal never waits on a dead card.
 */
export class TerminalConfirmations {
  readonly #ports: TerminalPorts;
  readonly #queue: Card[] = [];
  #current: Card | null = null;

  constructor(ports: TerminalPorts) {
    this.#ports = ports;
  }

  request(confirmationId: string, summary: string): void {
    this.#queue.push({ confirmationId, summary, controller: new AbortController() });
    this.#next();
  }

  /** The brain settled a card: it is no longer asked; how it ended is printed when nothing was done. */
  settled(confirmationId: string, outcome: ConfirmationOutcome): void {
    this.#drop((card) => card.confirmationId === confirmationId);
    if (outcome !== "approved") this.#ports.print(`  [${OUTCOME_LABELS[outcome]}]`);
  }

  /** The turn ended (or the connection did): no question survives it. */
  clear(): void {
    this.#drop(() => true);
  }

  #drop(matches: (card: Card) => boolean): void {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const card = this.#queue[i];
      if (card !== undefined && matches(card)) this.#queue.splice(i, 1);
    }
    if (this.#current !== null && matches(this.#current)) this.#current.controller.abort();
  }

  #next(): void {
    if (this.#current !== null) return;
    const card = this.#queue.shift();
    if (card === undefined) return;
    this.#current = card;
    const { signal } = card.controller;
    const finish = (approved: boolean): void => {
      // Settled elsewhere meanwhile: nothing to send.
      if (!signal.aborted) this.#ports.answer(card.confirmationId, approved);
      this.#current = null;
      this.#next();
    };
    this.#ports.ask(`\n  [confirmation] ${card.summary} (o/n) `, signal).then(
      (typed) => {
        finish(YES.test(typed.trim()));
      },
      // A closed prompt (Ctrl+C) is a no.
      () => {
        finish(false);
      },
    );
  }
}
