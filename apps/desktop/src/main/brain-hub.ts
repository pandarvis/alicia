import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { ChatConnection, type ConnectionStatus, type SocketLike, webSocketUrl } from "../shared/chat-connection.ts";
import type { Surface } from "../shared/surface.ts";

/** How a turn ended, and which window asked for it (the notification depends on both). */
export type FinishedTurn =
  | { origin: Surface; outcome: "answered"; conversationId: string; text: string }
  | { origin: Surface; outcome: "failed"; conversationId: string | undefined; message: string };

export interface BrainHubPorts {
  openSocket(url: string): SocketLike;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  /** Every event from the brain, already validated, for every window. */
  onEvent(event: ServerEvent): void;
  onStatus(status: ConnectionStatus): void;
  /** A message left for the brain. */
  onSent(origin: Surface): void;
  onTurnFinished(turn: FinishedTurn): void;
}

interface Turn {
  origin: Surface;
  conversationId: string | undefined;
  text: string;
}

const CONNECTION_LOST = "Connexion perdue : la réponse d'Alicia n'est pas arrivée.";
const DEVICE_REFUSED = "Cet appareil a été déconnecté d'Alicia.";

/**
 * The only connection from this PC to the brain, owned by the main process. Every window sends through it
 * and receives everything from it; the brain answers one turn at a time per connection, so one per PC.
 */
export class BrainHub {
  readonly #ports: BrainHubPorts;
  #connection: ChatConnection | null = null;
  #status: ConnectionStatus = "offline";
  /** Turns waiting for their end, by request id. */
  readonly #turns = new Map<string, Turn>();

  constructor(ports: BrainHubPorts) {
    this.#ports = ports;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  connect(session: { serverUrl: string; token: string }): void {
    this.disconnect();
    const connection: ChatConnection = new ChatConnection({
      url: webSocketUrl(session.serverUrl),
      token: session.token,
      openSocket: (url) => this.#ports.openSocket(url),
      schedule: (run, ms) => this.#ports.schedule(run, ms),
      onEvent: (event) => {
        if (this.#connection === connection) this.#receive(event);
      },
      onStatus: (status) => {
        if (this.#connection === connection) this.#setStatus(status);
      },
    });
    this.#connection = connection;
    connection.start();
  }

  /** Signed out: the connection closes and pending turns are forgotten (no notification). */
  disconnect(): void {
    const connection = this.#connection;
    if (connection === null) return;
    this.#connection = null;
    connection.stop();
    this.#turns.clear();
    this.#setStatus("offline");
  }

  send(message: SendMessage, origin: Surface): boolean {
    if (this.#connection?.send(message) !== true) return false;
    this.#turns.set(message.requestId, { origin, conversationId: message.conversationId, text: "" });
    this.#ports.onSent(origin);
    return true;
  }

  #receive(event: ServerEvent): void {
    this.#ports.onEvent(event);
    switch (event.type) {
      case "conversation": {
        const turn = this.#turns.get(event.requestId);
        if (turn !== undefined) turn.conversationId = event.conversationId;
        return;
      }
      case "text_delta": {
        const found = this.#find(event.conversationId);
        if (found !== undefined) found[1].text += event.text;
        return;
      }
      case "done": {
        const found = this.#find(event.conversationId);
        if (found === undefined) return;
        const [requestId, turn] = found;
        this.#finish(requestId, { origin: turn.origin, outcome: "answered", conversationId: event.conversationId, text: turn.text });
        return;
      }
      case "error": {
        const requestId = event.requestId ?? (event.conversationId === undefined ? undefined : this.#find(event.conversationId)?.[0]);
        const turn = requestId === undefined ? undefined : this.#turns.get(requestId);
        if (requestId === undefined || turn === undefined) return;
        this.#finish(requestId, {
          origin: turn.origin, outcome: "failed", conversationId: event.conversationId ?? turn.conversationId, message: event.message,
        });
        return;
      }
      case "heartbeat":
      case "ready":
      case "tool_call":
      case "tool_result":
        return;
    }
  }

  /** The oldest pending turn of a conversation (a refused second send in the same conversation comes after it). */
  #find(conversationId: string): [string, Turn] | undefined {
    for (const entry of this.#turns) {
      if (entry[1].conversationId === conversationId) return entry;
    }
    return undefined;
  }

  #finish(requestId: string, turn: FinishedTurn): void {
    this.#turns.delete(requestId);
    this.#ports.onTurnFinished(turn);
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#ports.onStatus(status);
    if (status !== "offline" && status !== "rejected") return;
    const message = status === "rejected" ? DEVICE_REFUSED : CONNECTION_LOST;
    for (const [requestId, turn] of [...this.#turns]) {
      this.#finish(requestId, { origin: turn.origin, outcome: "failed", conversationId: turn.conversationId, message });
    }
  }
}
