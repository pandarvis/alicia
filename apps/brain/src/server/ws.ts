import { randomUUID } from "node:crypto";
import { ClientMessage, type Person, type ServerEvent } from "@alicia/protocol";
import type { RawData, WebSocket } from "ws";
import { handleSend } from "../conversations/chat-service.ts";
import { ConfirmationBroker } from "../tools/confirmations.ts";
import { DEFAULT_DRAIN, waitForDrain } from "./backpressure.ts";
import type { ConversationLocks } from "./conversation-locks.ts";
import type { ServerDependencies } from "./server.ts";

const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_TRY_AGAIN_LATER = 1013;

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

  /** False when the socket is no longer open (the event is dropped). */
  const send = (event: ServerEvent): boolean => {
    if (socket.readyState !== socket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  };
  // Confirmations belong to this connection: only the device that started the turn can answer them.
  const broker = new ConfirmationBroker({
    send,
    newId: randomUUID,
    now: deps.chat.clock,
    schedule: (run, ms) => {
      const confirmationTimer = setTimeout(run, ms);
      return () => {
        clearTimeout(confirmationTimer);
      };
    },
    ...(deps.confirmationTimeoutMs !== undefined ? { timeoutMs: deps.confirmationTimeoutMs } : {}),
  });
  const reject = (message: string): void => {
    send({ type: "error", code: "unauthenticated", message });
    socket.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
  };

  const timer = setTimeout(() => {
    if (session === undefined) reject("Authentification attendue.");
  }, deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);

  // Heartbeat. Each period, a protocol ping; a socket that left the previous one unanswered is dead
  // (laptop asleep, Wi-Fi gone) and is terminated, which cancels its turns through "close".
  // Authenticated apps also get a "heartbeat" event: browsers hide protocol pings from pages,
  // so this is how the app notices a brain that went silent.
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    // A device revoked while idle is cut off here, not only on its next send.
    if (session !== undefined && !deps.pairing.isActive(session.deviceId)) {
      reject("Appareil révoqué.");
      return;
    }
    alive = false;
    socket.ping();
    if (session !== undefined) send({ type: "heartbeat" });
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

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
    // Answers arrive while a turn runs: handled before the "busy" check. A stale answer (card already settled,
    // another device's card, unknown) is no error: an error event would end a turn in the app.
    if (message.type === "confirm") {
      broker.answer(message.confirmationId, message.approved);
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
        for await (const e of handleSend(deps.chat, author, message, turn.signal, {
          confirm: (where, request, signal) => broker.ask(where, request, signal),
          confirmationTimeoutMs: broker.timeoutMs,
        })) {
          // New conversation: locked as soon as its id exists, before another device can see it.
          if (e.type === "conversation" && locked === undefined && locks.acquire(author.id, e.conversationId)) {
            locked = e.conversationId;
          }
          send(e);
          // The final event: nothing left to send, so no reason to hold the turn (and its lock) while the
          // app catches up.
          if (e.type === "done" || e.type === "error") continue;
          // Backpressure: reading the engine pauses while the app catches up; an app that stays behind
          // (or is gone) ends the turn instead of growing the buffer without limit. It reconnects and resyncs.
          if (!(await waitForDrain(socket, deps.drain ?? DEFAULT_DRAIN))) {
            turn.abort();
            if (socket.readyState === socket.OPEN) socket.close(CLOSE_TRY_AGAIN_LATER, "client too slow");
            break;
          }
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
    clearInterval(heartbeat);
    for (const turn of turns) turn.abort();
    // Belt and braces: each turn's signal already cancels its own confirmations.
    broker.cancelAll();
  };
  socket.on("close", abortTurns);
  // A socket error (frame too large, abrupt disconnect…) must not bring the process down:
  // cancel the running turns, as on close.
  socket.on("error", abortTurns);
}
