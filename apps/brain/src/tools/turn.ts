import type { Person } from "@alicia/protocol";
import { truncate } from "../text.ts";
import type { ConfirmationOutcome, ConfirmationRequest } from "./confirmations.ts";
import { userUrls } from "./urls.ts";

/** The protocol caps a card's question at 500 characters. */
const SUMMARY_MAX = 500;

export interface TurnParams {
  person: Person;
  conversationId: string;
  /** This conversation's attachments folder (absolute; may not exist yet). */
  attachmentsDir: string;
  /** Alicia's skills folder (a skill's own files may be read). */
  skillsDir: string;
  /** The person's message: the addresses it contains may be fetched without asking. */
  userText: string;
  /** Aborts when the turn ends, whatever the reason: nothing it asked may run afterwards. */
  signal: AbortSignal;
  /** Asks the person on the device that sent the message (settles "cancelled" when the turn ends). */
  confirm: (request: ConfirmationRequest) => Promise<ConfirmationOutcome>;
}

/** What a turn's tools and guards share: who speaks, where, and whether outside content entered the turn. */
export class TurnContext {
  readonly person: Person;
  readonly conversationId: string;
  readonly attachmentsDir: string;
  readonly skillsDir: string;
  /** The addresses of the person's message, in comparable form (see urlKey). */
  readonly userUrls: ReadonlySet<string>;
  readonly #signal: AbortSignal;
  readonly #confirm: TurnParams["confirm"];
  #untrusted = false;

  constructor(params: TurnParams) {
    this.person = params.person;
    this.conversationId = params.conversationId;
    this.attachmentsDir = params.attachmentsDir;
    this.skillsDir = params.skillsDir;
    this.userUrls = userUrls(params.userText);
    this.#signal = params.signal;
    this.#confirm = params.confirm;
  }

  /** True once outside content (document, web page, mail…) entered the turn. */
  get untrusted(): boolean {
    return this.#untrusted;
  }

  /** True once the turn is over: a question asked or answered from now on is cancelled. */
  get ended(): boolean {
    return this.#signal.aborted;
  }

  markUntrusted(): void {
    this.#untrusted = true;
  }

  confirm(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    if (this.ended) return Promise.resolve("cancelled");
    const summary = request.summary.trim() === ""
      ? `Alicia voudrait utiliser l'outil « ${request.tool} ». D'accord ?`
      : request.summary;
    return this.#confirm({ tool: request.tool, summary: truncate(summary, SUMMARY_MAX) });
  }
}
