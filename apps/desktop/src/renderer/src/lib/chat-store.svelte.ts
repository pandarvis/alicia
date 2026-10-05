import type {
  ConversationSummary, HistoryMessage, SendMessage, ServerEvent,
} from "@alicia/protocol";
import { MASCOT_ON_ERROR, type MascotState } from "../../../shared/mascot.ts";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
}

/** Everything the store needs from the outside world (fakes in tests). */
export interface ChatPorts {
  listConversations(): Promise<ConversationSummary[]>;
  history(conversationId: string): Promise<HistoryMessage[]>;
  send(message: SendMessage): boolean;
  deleteConversation(conversationId: string): Promise<"deleted" | "not_found" | "busy">;
  newId(): string;
  schedule(run: () => void, ms: number): () => void;
}

const SUCCESS_MS = 1500;
const ALERT_MS = 2000;

type TurnEvent = Extract<ServerEvent, { type: "text_delta" | "tool_call" | "tool_result" | "done" }>;

function isTurnEvent(event: ServerEvent): event is TurnEvent {
  return (
    event.type === "text_delta" || event.type === "tool_call" || event.type === "tool_result" || event.type === "done"
  );
}

export class ChatStore {
  conversations = $state<ConversationSummary[]>([]);
  activeId = $state<string | null>(null);
  messages = $state<ChatMessage[]>([]);
  busy = $state(false);
  /** True while a conversation history is being loaded. */
  loading = $state(false);
  opus = $state(false);
  activity = $state<string | null>(null);
  notice = $state<string | null>(null);
  mascot = $state<MascotState>("idle");

  readonly #ports: ChatPorts;
  #pendingRequestId: string | null = null;
  /** The conversation of this window's running turn, from its own `conversation` event. */
  #turnConversationId: string | null = null;
  #cancelMascotReset: (() => void) | null = null;
  /** A conversation asked from outside while this window's turn runs: opened when it ends. */
  #openAfterTurn: string | null = null;
  #loadToken = 0;
  #refreshToken = 0;

  constructor(ports: ChatPorts) {
    this.#ports = ports;
  }

  async refreshConversations(): Promise<void> {
    const token = ++this.#refreshToken;
    try {
      const list = await this.#ports.listConversations();
      if (token === this.#refreshToken) this.conversations = list;
    } catch {
      // Keep the current list; the connection status already tells the user what is wrong.
    }
  }

  async open(conversationId: string): Promise<void> {
    if (this.busy) return;
    this.activeId = conversationId;
    this.notice = null;
    this.messages = [];
    this.#setMascot("idle");
    await this.#loadHistory(conversationId);
  }

  /**
   * Opens a conversation asked from outside (a notification, the Holo): at once, or when this window's own
   * answer has ended (switching in the middle would lose it).
   */
  openWhenIdle(conversationId: string): void {
    if (this.busy) {
      this.#openAfterTurn = conversationId;
      return;
    }
    this.#openAfterTurn = null;
    void this.open(conversationId);
  }

  /** Reloads the active conversation after the connection came back (the brain may have finished a lost turn). */
  async resync(): Promise<void> {
    if (this.busy || this.activeId === null) return;
    await Promise.all([this.#loadHistory(this.activeId), this.refreshConversations()]);
  }

  /**
   * Deletes a conversation for good. Gone (or already gone): it leaves the list and, if it was open,
   * the welcome shows again. Refused while Alicia answers in it, or when the brain cannot be reached: kept
   * (the menu row says why, so the chat notice is left alone).
   */
  async removeConversation(conversationId: string): Promise<"deleted" | "not_found" | "busy" | "failed"> {
    let result: "deleted" | "not_found" | "busy";
    try {
      result = await this.#ports.deleteConversation(conversationId);
    } catch {
      return "failed";
    }
    if (result === "busy") return result;
    // A list fetched before the deletion would bring it back.
    this.#refreshToken++;
    this.conversations = this.conversations.filter((c) => c.id !== conversationId);
    if (this.activeId === conversationId) this.startNew();
    return result;
  }

  startNew(): void {
    if (this.busy) return;
    this.#loadToken++;
    this.loading = false;
    this.activeId = null;
    this.messages = [];
    this.notice = null;
    this.#setMascot("idle");
  }

  send(text: string): boolean {
    if (text.trim() === "" || this.busy || this.loading) return false;
    const requestId = this.#ports.newId();
    const message: SendMessage = {
      type: "send",
      requestId,
      text,
      ...(this.activeId !== null ? { conversationId: this.activeId } : {}),
      ...(this.opus ? { model: "opus" as const } : {}),
    };
    if (!this.#ports.send(message)) {
      this.notice = "Alicia n'est pas joignable pour l'instant.";
      return false;
    }
    this.#pendingRequestId = requestId;
    this.busy = true;
    // « Réfléchir » is for one message: the next one goes back to the default model.
    this.opus = false;
    this.notice = null;
    this.activity = null;
    this.messages.push({ id: this.#ports.newId(), role: "user", text, streaming: false });
    this.#setMascot("thinking");
    return true;
  }

  handle(event: ServerEvent): void {
    // Another window's turn (Holo, Spotlight) ended: the list may have changed, and maybe the open conversation.
    if (event.type === "done" && !this.#isCurrentTurn(event.conversationId)) {
      this.#otherTurnDone(event.conversationId);
      return;
    }
    if (isTurnEvent(event) && !this.#isCurrentTurn(event.conversationId)) return;
    switch (event.type) {
      case "ready":
      case "heartbeat":
        return;
      case "conversation":
        if (event.requestId !== this.#pendingRequestId) return;
        this.#turnConversationId = event.conversationId;
        if (this.activeId === null) this.activeId = event.conversationId;
        void this.refreshConversations();
        return;
      case "text_delta": {
        this.activity = null;
        const last = this.messages.at(-1);
        if (last?.role === "assistant" && last.streaming) last.text += event.text;
        else this.messages.push({ id: this.#ports.newId(), role: "assistant", text: event.text, streaming: true });
        this.#setMascot("speaking");
        return;
      }
      case "tool_call":
        this.activity = event.label;
        this.#setMascot(event.tool === "memory_remember" ? "idea" : "thinking");
        return;
      case "tool_result":
        return;
      case "done":
        this.#endTurn();
        this.#setMascot("success", SUCCESS_MS);
        void this.refreshConversations();
        return;
      case "error":
        if (event.requestId !== undefined && event.requestId !== this.#pendingRequestId) return;
        this.#endTurn();
        this.notice = event.message;
        this.#setMascot(MASCOT_ON_ERROR[event.code] ?? "alert", event.code === "busy" ? ALERT_MS : undefined);
        return;
    }
  }

  connectionLost(): void {
    if (!this.busy) return;
    this.#endTurn();
    this.notice = "Connexion perdue : la réponse d'Alicia n'est pas arrivée.";
    this.#setMascot("alert");
  }

  /** The main process could not deliver the message `send` accepted: same outcome as a refused send. */
  undelivered(requestId: string): void {
    if (requestId !== this.#pendingRequestId) return;
    this.#endTurn();
    this.notice = "Alicia n'est pas joignable pour l'instant.";
    this.#setMascot("alert");
  }

  #otherTurnDone(conversationId: string): void {
    void this.refreshConversations();
    if (!this.busy && conversationId === this.activeId) void this.#loadHistory(conversationId);
  }

  /**
   * Turn events only count while this window's turn is pending, and only once the brain named its conversation
   * (its `conversation` event always comes first): before that, an event of the same conversation is another
   * window's turn ending (its `done` reaches every window).
   */
  #isCurrentTurn(conversationId: string): boolean {
    return this.busy && this.#turnConversationId === conversationId;
  }

  /** Loads a history; only the latest load may assign messages or report an error. */
  async #loadHistory(conversationId: string): Promise<void> {
    const token = ++this.#loadToken;
    this.loading = true;
    try {
      const history = await this.#ports.history(conversationId);
      if (token !== this.#loadToken) return;
      this.messages = history.map((m) => ({ id: m.id, role: m.role, text: m.text, streaming: false }));
    } catch {
      if (token !== this.#loadToken) return;
      this.notice = "Impossible de charger cette conversation pour l'instant.";
    } finally {
      if (token === this.#loadToken) this.loading = false;
    }
  }

  #endTurn(): void {
    const last = this.messages.at(-1);
    if (last?.role === "assistant") last.streaming = false;
    this.busy = false;
    this.activity = null;
    this.#pendingRequestId = null;
    this.#turnConversationId = null;
    const next = this.#openAfterTurn;
    this.#openAfterTurn = null;
    if (next !== null) void this.open(next);
  }

  /** Sets the mascot; with `resetAfterMs`, goes back to idle afterwards. */
  #setMascot(state: MascotState, resetAfterMs?: number): void {
    this.#cancelMascotReset?.();
    this.#cancelMascotReset = null;
    this.mascot = state;
    if (resetAfterMs !== undefined) {
      this.#cancelMascotReset = this.#ports.schedule(() => {
        this.mascot = "idle";
      }, resetAfterMs);
    }
  }
}
