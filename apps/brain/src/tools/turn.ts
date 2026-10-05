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
  /**
   * The conversation already let outside content in (an earlier turn): it is still in the session, the resume
   * prompt or what was remembered, so this turn starts untrusted. Default false.
   */
  untrusted?: boolean;
  /** Called once when this turn makes a trusted conversation untrusted (the conversation keeps it). */
  onUntrusted?: () => void;
  /** Aborts when the turn ends, whatever the reason: nothing it asked may run afterwards. */
  signal: AbortSignal;
  /**
   * Asks the person on the device that sent the message; must settle "cancelled" when `signal` aborts (it aborts
   * with the turn, and with whatever else the asker waits on).
   */
  confirm: (request: ConfirmationRequest, signal: AbortSignal) => Promise<ConfirmationOutcome>;
}

/** What a turn's tools and guards share: who speaks, where, and whether outside content entered the turn. */
export class TurnContext {
  readonly person: Person;
  readonly conversationId: string;
  readonly attachmentsDir: string;
  readonly skillsDir: string;
  /** The addresses of the person's message, in comparable form (see urlKey). */
  readonly userUrls: ReadonlySet<string>;
  readonly #searchUrls = new Set<string>();
  readonly #signal: AbortSignal;
  readonly #confirm: TurnParams["confirm"];
  readonly #onUntrusted: (() => void) | undefined;
  #untrusted: boolean;
  /** The conversation already carries the mark (it started untrusted, or this turn wrote it). */
  #persisted: boolean;

  constructor(params: TurnParams) {
    this.person = params.person;
    this.conversationId = params.conversationId;
    this.attachmentsDir = params.attachmentsDir;
    this.skillsDir = params.skillsDir;
    this.userUrls = userUrls(params.userText);
    this.#untrusted = params.untrusted ?? false;
    this.#persisted = this.#untrusted;
    this.#onUntrusted = params.onUntrusted;
    this.#signal = params.signal;
    this.#confirm = params.confirm;
  }

  /** True once outside content (document, web page, search results, mail…) entered the turn or the conversation. */
  get untrusted(): boolean {
    return this.#untrusted;
  }

  /** Aborts when the turn ends, whatever the reason. */
  get signal(): AbortSignal {
    return this.#signal;
  }

  /** True once the turn is over: a question asked or answered from now on is cancelled. */
  get ended(): boolean {
    return this.#signal.aborted;
  }

  /** Outside content entered the turn: kept here at once, passed on to the conversation (see persistUntrusted). */
  markUntrusted(): void {
    this.#untrusted = true;
    this.persistUntrusted();
  }

  /**
   * Passes the mark on to the conversation, once. A failed write (locked database…) never drops the mark of this
   * turn: it is logged, and tried again at the next mark and when the turn ends.
   */
  persistUntrusted(): void {
    if (!this.#untrusted || this.#persisted || this.#onUntrusted === undefined) return;
    try {
      this.#onUntrusted();
      this.#persisted = true;
    } catch (error) {
      console.error(`Conversation ${this.conversationId}: the outside-content mark could not be saved:`, error);
    }
  }

  /** Addresses a web search of this turn returned (comparable form): they may be opened without asking. */
  addSearchUrls(keys: Iterable<string>): void {
    for (const key of keys) this.#searchUrls.add(key);
  }

  /** An address the person wrote, or one a search of this turn returned (comparable form). */
  knowsUrl(key: string): boolean {
    return this.userUrls.has(key) || this.#searchUrls.has(key);
  }

  /** Asks the person; `signal` (e.g. the SDK hook's) cancels the question too, besides the end of the turn. */
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationOutcome> {
    if (this.ended || signal?.aborted === true) return Promise.resolve("cancelled");
    const summary = request.summary.trim() === ""
      ? `Alicia voudrait utiliser l'outil « ${request.tool} ». D'accord ?`
      : request.summary;
    const scope = signal === undefined ? this.#signal : AbortSignal.any([this.#signal, signal]);
    return this.#confirm({ tool: request.tool, summary: truncate(summary, SUMMARY_MAX) }, scope);
  }
}
