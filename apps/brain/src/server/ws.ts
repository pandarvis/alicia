import { ClientMessage, type Person, type ServerEvent } from "@alicia/protocol";
import type { RawData, WebSocket } from "ws";
import { handleSend } from "../conversations/chat-service.ts";
import type { ConversationLocks } from "./conversation-locks.ts";
import type { ServerDependencies } from "./server.ts";

const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_INTERNAL_ERROR = 1011;

export function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function readMessage(data: RawData): ClientMessage | undefined {
  try {
    const result = ClientMessage.safeParse(JSON.parse(toText(data)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function attachWs(socket: WebSocket, deps: ServerDependencies, locks: ConversationLocks): void {
  let session: { deviceId: string; person: Person } | undefined;
  const turns = new Set<AbortController>();

  const send = (event: ServerEvent): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const reject = (message: string): void => {
    send({ type: "error", code: "unauthenticated", message });
    socket.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
  };

  const timer = setTimeout(() => {
    if (session === undefined) reject("Authentification attendue.");
  }, deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);

  const handle = (data: RawData): void => {
    const message = readMessage(data);

    if (session === undefined) {
      if (message?.type !== "authenticate") {
        reject("Authentification attendue.");
        return;
      }
      const found = deps.pairing.authenticateDevice(message.token);
      if (found === undefined) {
        reject("Jeton refusé.");
        return;
      }
      session = found;
      clearTimeout(timer);
      send({ type: "ready", person: found.person });
      return;
    }

    if (message === undefined) {
      send({ type: "error", code: "invalid_request", message: "Message invalide." });
      return;
    }
    if (message.type === "authenticate") {
      // The identity is fixed for the whole lifetime of the connection.
      send({ type: "error", code: "invalid_request", message: "Déjà authentifié." });
      return;
    }
    // A device revoked during the connection loses access on its next send.
    if (!deps.pairing.isActive(session.deviceId)) {
      reject("Appareil révoqué.");
      return;
    }
    if (turns.size > 0) {
      send({
        type: "error",
        requestId: message.requestId,
        code: "busy",
        message: "Alicia répond déjà ; réessaie après sa réponse.",
      });
      return;
    }

    const author = session.person;
    // Existing conversation: locked before the turn, whichever device is already answering in it.
    let locked: string | undefined;
    if (message.conversationId !== undefined) {
      if (!locks.acquire(author.id, message.conversationId)) {
        send({
          type: "error",
          requestId: message.requestId,
          code: "busy",
          message: "Alicia répond déjà dans cette conversation.",
        });
        return;
      }
      locked = message.conversationId;
    }

    const turn = new AbortController();
    turns.add(turn);
    void (async () => {
      try {
        for await (const e of handleSend(deps.chat, author, message, turn.signal)) {
          // New conversation: locked as soon as its id exists, before another device can see it.
          if (e.type === "conversation" && locked === undefined && locks.acquire(author.id, e.conversationId)) {
            locked = e.conversationId;
          }
          send(e);
        }
      } catch {
        send({ type: "error", requestId: message.requestId, code: "internal", message: "Erreur interne." });
      } finally {
        turns.delete(turn);
        if (locked !== undefined) locks.release(author.id, locked);
      }
    })();
  };

  socket.on("message", (data: RawData) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      handle(data);
    } catch {
      // A synchronous exception must never bring the process down.
      send({ type: "error", code: "internal", message: "Erreur interne." });
      socket.close(CLOSE_INTERNAL_ERROR, "internal error");
    }
  });

  const abortTurns = (): void => {
    clearTimeout(timer);
    for (const turn of turns) turn.abort();
  };
  socket.on("close", abortTurns);
  // A socket error (frame too large, abrupt disconnect…) must not bring the process down:
  // cancel the running turns, as on close.
  socket.on("error", abortTurns);
}
