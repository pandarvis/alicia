import type { ErrorCode, SendMessage, ServerEvent } from "@alicia/protocol";
import { ChatConnection, type ConnectionStatus, type SocketLike, webSocketUrl } from "../shared/chat-connection.ts";
import type { Surface } from "../shared/surface.ts";

/** How a turn ended, and which window asked for it (the notification depends on both). */
export type FinishedTurn =
  | { origin: Surface; outcome: "answered"; conversationId: string; text: string }
  | {
    origin: Surface;
    outcome: "failed";
    conversationId: string | undefined;
    message: string;
    /** The brain's error code; none when the connection itself failed. */
    code?: ErrorCode;
  };

export interface BrainHubPorts {
  openSocket(url: string): SocketLike;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  /**
   * Every event from the brain, already validated. `owner`: the window whose turn the event belongs to;
   * undefined for events of the whole connection (ready) and for events of no known turn.
   */
  onEvent(event: ServerEvent, owner: Surface | undefined): void;
  onStatus(status: ConnectionStatus): void;
  /** A message left for the brain; `pendingTurns` counts it. */
  onSent(origin: Surface, pendingTurns: number): void;
  /** `pendingTurns`: the turns still running afterwards. */
  onTurnFinished(turn: FinishedTurn, pendingTurns: number): void;
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
 * and receives from it; the brain answers one turn at a time per connection, so one per PC. The hub's own
 * bookkeeping always happens before its consumers are called, and a failing consumer is logged, never fatal.
 */
export class BrainHub {
  readonly #ports: BrainHubPorts;
  #connection: ChatConnection | null = null;
  #status: ConnectionStatus = "offline";
  /** Turns waiting for their end, by request id, oldest first. */
  readonly #turns = new Map<string, Turn>();

  constructor(ports: BrainHubPorts) {
    this.#ports = ports;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /** Connects to the paired brain; a previous connection is replaced without passing through "offline". */
  connect(session: { serverUrl: string; token: string }): void {
    this.#teardown();
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
    if (this.#teardown()) this.#setStatus("offline");
  }

  /** False when not connected, or when this request id is already pending. */
  send(message: SendMessage, origin: Surface): boolean {
    if (this.#turns.has(message.requestId)) return false;
    if (this.#connection?.send(message) !== true) return false;
    this.#turns.set(message.requestId, { origin, conversationId: message.conversationId, text: "" });
    const pending = this.#turns.size;
    this.#safely("onSent", () => {
      this.#ports.onSent(origin, pending);
    });
    return true;
  }

  /** Stops the current connection and forgets its turns; true when there was one. */
  #teardown(): boolean {
    const connection = this.#connection;
    if (connection === null) return false;
    this.#connection = null;
    connection.stop();
    this.#turns.clear();
    return true;
  }

  #receive(event: ServerEvent): void {
    // Bookkeeping first: which turn the event belongs to, and whether it ends it.
    let requestId: string | undefined;
    let finished: FinishedTurn | null = null;
    switch (event.type) {
      case "conversation": {
        const turn = this.#turns.get(event.requestId);
        if (turn !== undefined) {
          turn.conversationId = event.conversationId;
          requestId = event.requestId;
        }
        break;
      }
      case "text_delta": {
        requestId = this.#find(event.conversationId);
        const turn = requestId === undefined ? undefined : this.#turns.get(requestId);
        if (turn !== undefined) turn.text += event.text;
        break;
      }
      case "tool_call":
      case "tool_result":
        requestId = this.#find(event.conversationId);
        break;
      case "done": {
        requestId = this.#find(event.conversationId);
        const turn = requestId === undefined ? undefined : this.#turns.get(requestId);
        if (turn !== undefined) {
          finished = { origin: turn.origin, outcome: "answered", conversationId: event.conversationId, text: turn.text };
        }
        break;
      }
      case "error": {
        requestId = this.#errorTurn(event);
        const turn = requestId === undefined ? undefined : this.#turns.get(requestId);
        if (turn !== undefined) {
          finished = {
            origin: turn.origin,
            outcome: "failed",
            conversationId: event.conversationId ?? turn.conversationId,
            message: event.message,
            code: event.code,
          };
        }
        break;
      }
      case "heartbeat":
      case "ready":
        break;
    }
    const owner = requestId === undefined ? undefined : this.#turns.get(requestId)?.origin;
    if (finished !== null && requestId !== undefined) this.#turns.delete(requestId);
    const pending = this.#turns.size;

    this.#safely("onEvent", () => {
      this.#ports.onEvent(event, owner);
    });
    if (finished !== null) this.#report(finished, pending);
  }

  /**
   * The turn an error ends: by request id, else by conversation, else (no id at all) the oldest turn still
   * waiting for its conversation; undefined when none matches (the error is then nobody's).
   */
  #errorTurn(event: Extract<ServerEvent, { type: "error" }>): string | undefined {
    if (event.requestId !== undefined) return this.#turns.has(event.requestId) ? event.requestId : undefined;
    if (event.conversationId !== undefined) return this.#find(event.conversationId);
    for (const [requestId, turn] of this.#turns) {
      if (turn.conversationId === undefined) return requestId;
    }
    return undefined;
  }

  /** The oldest pending turn of a conversation (a refused second send in the same conversation comes after it). */
  #find(conversationId: string): string | undefined {
    for (const [requestId, turn] of this.#turns) {
      if (turn.conversationId === conversationId) return requestId;
    }
    return undefined;
  }

  #report(turn: FinishedTurn, pending: number): void {
    this.#safely("onTurnFinished", () => {
      this.#ports.onTurnFinished(turn, pending);
    });
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    const lost: FinishedTurn[] = [];
    if (status === "offline" || status === "rejected") {
      const message = status === "rejected" ? DEVICE_REFUSED : CONNECTION_LOST;
      for (const turn of this.#turns.values()) {
        lost.push({ origin: turn.origin, outcome: "failed", conversationId: turn.conversationId, message });
      }
      this.#turns.clear();
    }
    this.#safely("onStatus", () => {
      this.#ports.onStatus(status);
    });
    for (const turn of lost) this.#report(turn, 0);
  }

  #safely(port: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(`brain hub: ${port} failed`, error);
    }
  }
}
