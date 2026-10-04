import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { BrainHub, type FinishedTurn } from "../src/main/brain-hub.ts";
import type { ConnectionStatus, SocketLike } from "../src/shared/chat-connection.ts";
import type { Surface } from "../src/shared/surface.ts";

const SESSION = { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43) };
const READY = { type: "ready", person: { id: "kevin", name: "Kévin" } };
const REQUEST = "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const OTHER_REQUEST = "8b2d3c0f-9b5e-4d2f-8c8b-3e6f7a819203";
const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const DONE = { type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 2, durationMs: 3 };

class FakeSocket implements SocketLike {
  readonly url: string;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  receive(event: unknown): void {
    this.onmessage?.(JSON.stringify(event));
  }
}

function message(requestId = REQUEST, text = "Salut"): SendMessage {
  return { type: "send", requestId, text };
}

function setup() {
  const sockets: FakeSocket[] = [];
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const sent: Surface[] = [];
  const finished: FinishedTurn[] = [];
  const hub = new BrainHub({
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    schedule: () => () => undefined,
    onEvent: (event) => { events.push(event); },
    onStatus: (status) => { statuses.push(status); },
    onSent: (origin) => { sent.push(origin); },
    onTurnFinished: (turn) => { finished.push(turn); },
  });
  const socket = (): FakeSocket => {
    const last = sockets.at(-1);
    if (last === undefined) throw new Error("no socket");
    return last;
  };
  const connectReady = (): void => {
    hub.connect(SESSION);
    socket().onopen?.();
    socket().receive(READY);
  };
  return { hub, sockets, events, statuses, sent, finished, socket, connectReady };
}

describe("BrainHub", () => {
  test("connects to the paired brain, relays every event and status", () => {
    const { hub, socket, events, statuses, connectReady } = setup();
    expect(hub.status).toBe("offline");
    connectReady();
    expect(socket().url).toBe("ws://127.0.0.1:8780/ws");
    expect(socket().sent[0]).toBe(JSON.stringify({ type: "authenticate", token: SESSION.token }));
    expect(statuses).toEqual(["connecting", "ready"]);
    expect(events).toEqual([READY]);
    expect(hub.status).toBe("ready");
  });

  test("send is refused until ready, then remembers which window asked", () => {
    const { hub, socket, sent, connectReady } = setup();
    expect(hub.send(message(), "spotlight")).toBe(false);
    connectReady();
    expect(hub.send(message(), "spotlight")).toBe(true);
    expect(socket().sent.at(-1)).toBe(JSON.stringify(message()));
    expect(sent).toEqual(["spotlight"]);
  });

  test("an answered turn reports its window, conversation and whole text", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "spotlight");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Bonjour " });
    socket().receive({ type: "tool_call", conversationId: CONV, callId: "c", tool: "weather" });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Kévin" });
    expect(finished).toEqual([]);
    socket().receive(DONE);
    expect(finished).toEqual([{ origin: "spotlight", outcome: "answered", conversationId: CONV, text: "Bonjour Kévin" }]);
  });

  test("a refused send (busy) fails with the brain's message, the running turn goes on", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    hub.send(message(OTHER_REQUEST, "Et aussi"), "spotlight");
    socket().receive({ type: "error", requestId: OTHER_REQUEST, code: "busy", message: "Alicia répond déjà ; réessaie après sa réponse." });
    expect(finished).toEqual([
      { origin: "spotlight", outcome: "failed", conversationId: undefined, message: "Alicia répond déjà ; réessaie après sa réponse." },
    ]);
    socket().receive(DONE);
    expect(finished.at(-1)).toMatchObject({ origin: "main", outcome: "answered", conversationId: CONV });
  });

  test("an engine error is matched by request, with its conversation", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "holo");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "error", requestId: REQUEST, conversationId: CONV, code: "engine", message: "Le moteur a échoué." });
    expect(finished).toEqual([{ origin: "holo", outcome: "failed", conversationId: CONV, message: "Le moteur a échoué." }]);
  });

  test("connection lost mid-turn: the turn fails once, with an explanation", () => {
    const { hub, socket, finished, statuses, connectReady } = setup();
    connectReady();
    hub.send(message(), "spotlight");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().onclose?.(1006);
    expect(statuses.at(-1)).toBe("offline");
    expect(finished).toEqual([
      { origin: "spotlight", outcome: "failed", conversationId: CONV, message: "Connexion perdue : la réponse d'Alicia n'est pas arrivée." },
    ]);
  });

  test("disconnect closes the socket, forgets the turns, and ignores the old socket", () => {
    const { hub, socket, events, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    const old = socket();
    hub.disconnect();
    expect(old.closedWith).toBe(1000);
    expect(hub.status).toBe("offline");
    old.receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    expect(events).toEqual([READY]);
    expect(finished).toEqual([]);
  });

  test("connecting again replaces the previous connection", () => {
    const { hub, sockets, connectReady } = setup();
    connectReady();
    hub.connect({ serverUrl: "https://alicia.ts.net", token: "u".repeat(43) });
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(sockets[1]?.url).toBe("wss://alicia.ts.net/ws");
  });
});
