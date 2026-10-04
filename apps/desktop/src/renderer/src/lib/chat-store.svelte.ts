import type { ConversationSummary, HistoryMessage, SendMessage, ServerEvent } from "@alicia/protocol";
import type { MascotState } from "./mascot.ts";

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
  newId(): string;
  schedule(run: () => void, ms: number): () => void;
}

const SUCCESS_MS = 1500;
const ALERT_MS = 2000;
const MASCOT_ON_ERROR: Readonly<Record<string, MascotState>> = {
  quota: "sleeping",
  busy: "alert",
  engine: "error",
  internal: "error",
};

export class ChatStore {
  conversations = $state<ConversationSummary[]>([]);
  activeId = $state<string | null>(null);
  messages = $state<ChatMessage[]>([]);
  busy = $state(false);
  opus = $state(false);
  activity = $state<string | null>(null);
  notice = $state<string | null>(null);
  mascot = $state<MascotState>("idle");

  readonly #ports: ChatPorts;
  #pendingRequestId: string | null = null;
  #cancelMascotReset: (() => void) | null = null;

  constructor(ports: ChatPorts) {
    this.#ports = ports;
  }

  async refreshConversations(): Promise<void> {
    try {
      this.conversations = await this.#ports.listConversations();
    } catch {
      // Keep the current list; the connection status already tells the user what is wrong.
    }
  }

  async open(conversationId: string): Promise<void> {
    if (this.busy) return;
    this.activeId = conversationId;
    this.notice = null;
    this.#setMascot("idle");
    try {
      const history = await this.#ports.history(conversationId);
      if (this.activeId !== conversationId) return;
      this.messages = history.map((m) => ({ id: m.id, role: m.role, text: m.text, streaming: false }));
    } catch {
      this.notice = "Impossible de charger cette conversation.";
    }
  }

  startNew(): void {
    if (this.busy) return;
    this.activeId = null;
    this.messages = [];
    this.notice = null;
    this.#setMascot("idle");
  }

  send(text: string): boolean {
    if (text.trim() === "" || this.busy) return false;
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
    this.notice = null;
    this.activity = null;
    this.messages.push({ id: this.#ports.newId(), role: "user", text, streaming: false });
    this.#setMascot("thinking");
    return true;
  }

  handle(event: ServerEvent): void {
    switch (event.type) {
      case "ready":
        return;
      case "conversation":
        if (event.requestId !== this.#pendingRequestId) return;
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
        this.activity = `Alicia utilise l'outil « ${event.tool} »…`;
        this.#setMascot("thinking");
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

  #endTurn(): void {
    const last = this.messages.at(-1);
    if (last?.role === "assistant") last.streaming = false;
    this.busy = false;
    this.activity = null;
    this.#pendingRequestId = null;
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
