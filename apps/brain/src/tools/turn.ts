import type { Person } from "@alicia/protocol";
import { truncate } from "../text.ts";
import type { ConfirmationOutcome, ConfirmationRequest } from "./confirmations.ts";

/** The protocol caps a card's question at 500 characters. */
const SUMMARY_MAX = 500;

export interface TurnParams {
  person: Person;
  conversationId: string;
  /** Asks the person on the device that sent the message (settles "cancelled" if the turn stops). */
  confirm: (request: ConfirmationRequest) => Promise<ConfirmationOutcome>;
}

/** What a turn's tools and guards share: who speaks, where, and whether outside content entered the turn. */
export class TurnContext {
  readonly person: Person;
  readonly conversationId: string;
  readonly #confirm: TurnParams["confirm"];
  #untrusted = false;

  constructor(params: TurnParams) {
    this.person = params.person;
    this.conversationId = params.conversationId;
    this.#confirm = params.confirm;
  }

  /** True once outside content (document, web page, mail…) entered the turn. */
  get untrusted(): boolean {
    return this.#untrusted;
  }

  markUntrusted(): void {
    this.#untrusted = true;
  }

  confirm(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    return this.#confirm({ tool: request.tool, summary: truncate(request.summary, SUMMARY_MAX) });
  }
}
