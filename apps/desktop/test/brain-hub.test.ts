import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BrainHub, type BrainHubPorts, type FinishedTurn } from "../src/main/brain-hub.ts";
import type { ConnectionStatus, SocketLike } from "../src/shared/chat-connection.ts";
import type { Surface } from "../src/shared/surface.ts";

const SESSION = { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43) };
const READY = { type: "ready", person: { id: "kevin", name: "Kévin" } };
const REQUEST = "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const OTHER_REQUEST = "8b2d3c0f-9b5e-4d2f-8c8b-3e6f7a819203";
const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const OTHER_CONV = "7a9d0c3e-1b2f-4e5a-8c6d-9e0f1a2b3c4d";
const DONE = { type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 2, durationMs: 3 };
const LOST = "Connexion perdue : la réponse d'Alicia n'est pas arrivée.";

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

function setup(overrides: Partial<BrainHubPorts> = {}) {
  const sockets: FakeSocket[] = [];
  const events: ServerEvent[] = [];
  const owners: (Surface | undefined)[] = [];
  const statuses: ConnectionStatus[] = [];
  const sent: [Surface, number][] = [];
  const finished: FinishedTurn[] = [];
  const pendingAfter: number[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const hub = new BrainHub({
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return () => undefined;
    },
    onEvent: (event, owner) => {
      events.push(event);
      owners.push(owner);
    },
    onStatus: (status) => { statuses.push(status); },
    onSent: (origin, pending) => { sent.push([origin, pending]); },
    onTurnFinished: (turn, pending) => {
      finished.push(turn);
      pendingAfter.push(pending);
    },
    ...overrides,
  });
  const socket = (): FakeSocket => {
    const last = sockets.at(-1);
    if (last === undefined) throw new Error("no socket");
    return last;
  };
  const ready = (): void => {
    socket().onopen?.();
    socket().receive(READY);
  };
  const connectReady = (): void => {
    hub.connect(SESSION);
    ready();
  };
  /** Runs the reconnect timer (the longest pending one is never needed here: the first retry is 1 s). */
  const retry = (): void => {
    const timer = timers.find((t) => t.ms === 1000);
    if (timer === undefined) throw new Error("no retry scheduled");
    timers.splice(timers.indexOf(timer), 1);
    timer.run();
  };
  return { hub, sockets, events, owners, statuses, sent, finished, pendingAfter, socket, ready, connectReady, retry };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrainHub", () => {
  test("connects to the paired brain, relays every event and status", () => {
    const { hub, socket, events, owners, statuses, connectReady } = setup();
    expect(hub.status).toBe("offline");
    connectReady();
    expect(socket().url).toBe("ws://127.0.0.1:8780/ws");
    expect(socket().sent[0]).toBe(JSON.stringify({ type: "authenticate", token: SESSION.token }));
    expect(statuses).toEqual(["connecting", "ready"]);
    expect(events).toEqual([READY]);
    expect(owners).toEqual([undefined]);
    expect(hub.status).toBe("ready");
  });

  test("send is refused until ready, then remembers which window asked", () => {
    const { hub, socket, sent, connectReady } = setup();
    expect(hub.send(message(), "spotlight")).toBe(false);
    connectReady();
    expect(hub.send(message(), "spotlight")).toBe(true);
    expect(socket().sent.at(-1)).toBe(JSON.stringify(message()));
    expect(sent).toEqual([["spotlight", 1]]);
  });

  test("a request id already pending is refused", () => {
    const { hub, socket, connectReady } = setup();
    connectReady();
    expect(hub.send(message(), "main")).toBe(true);
    const count = socket().sent.length;
    expect(hub.send(message(), "holo")).toBe(false);
    expect(socket().sent).toHaveLength(count);
  });

  test("turn events name the window that asked; others belong to everyone", () => {
    const { hub, socket, owners, connectReady } = setup();
    connectReady();
    hub.send(message(), "holo");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Bonjour" });
    socket().receive({ type: "tool_call", conversationId: CONV, callId: "c", tool: "weather", label: "Alicia regarde la météo…" });
    socket().receive({ type: "tool_result", conversationId: CONV, callId: "c", success: true });
    socket().receive({ type: "text_delta", conversationId: OTHER_CONV, text: "?" });
    socket().receive(DONE);
    expect(owners).toEqual([undefined, "holo", "holo", "holo", "holo", undefined, "holo"]);
  });

  test("the main window starting a conversation while the Holo streams: each event goes to its own window", () => {
    const { hub, socket, owners, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "holo");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Bon" });
    hub.send(message(OTHER_REQUEST, "Et moi ?"), "main");
    socket().receive({ type: "text_delta", conversationId: CONV, text: "jour" });
    socket().receive({ type: "error", requestId: OTHER_REQUEST, code: "busy", message: "Alicia répond déjà." });
    socket().receive(DONE);
    expect(owners.slice(1)).toEqual(["holo", "holo", "holo", "main", "holo"]);
    expect(finished.map((turn) => [turn.origin, turn.outcome])).toEqual([["main", "failed"], ["holo", "answered"]]);
  });

  test("an answered turn reports its window, conversation and whole text", () => {
    const { hub, socket, finished, pendingAfter, connectReady } = setup();
    connectReady();
    hub.send(message(), "spotlight");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Bonjour " });
    socket().receive({ type: "tool_call", conversationId: CONV, callId: "c", tool: "weather", label: "Alicia regarde la météo…" });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Kévin" });
    expect(finished).toEqual([]);
    socket().receive(DONE);
    expect(finished).toEqual([{ origin: "spotlight", outcome: "answered", conversationId: CONV, text: "Bonjour Kévin" }]);
    expect(pendingAfter).toEqual([0]);
  });

  test("a refused send (busy) fails with the brain's message and code, the running turn goes on", () => {
    const { hub, socket, finished, pendingAfter, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    hub.send(message(OTHER_REQUEST, "Et aussi"), "spotlight");
    socket().receive({ type: "error", requestId: OTHER_REQUEST, code: "busy", message: "Alicia répond déjà ; réessaie après sa réponse." });
    expect(finished).toEqual([
      { origin: "spotlight", outcome: "failed", conversationId: undefined, code: "busy", message: "Alicia répond déjà ; réessaie après sa réponse." },
    ]);
    expect(pendingAfter).toEqual([1]);
    socket().receive(DONE);
    expect(finished.at(-1)).toMatchObject({ origin: "main", outcome: "answered", conversationId: CONV });
  });

  test("an engine error is matched by request, with its conversation", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "holo");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "error", requestId: REQUEST, conversationId: CONV, code: "engine", message: "Le moteur a échoué." });
    expect(finished).toEqual([{ origin: "holo", outcome: "failed", conversationId: CONV, code: "engine", message: "Le moteur a échoué." }]);
  });

  test("an error with only a conversation id is matched by conversation", () => {
    const { hub, socket, finished, owners, connectReady } = setup();
    connectReady();
    hub.send(message(), "holo");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "error", conversationId: CONV, code: "quota", message: "Quota atteint." });
    expect(finished).toEqual([{ origin: "holo", outcome: "failed", conversationId: CONV, code: "quota", message: "Quota atteint." }]);
    expect(owners.at(-1)).toBe("holo");
  });

  test("an error with no id ends the oldest turn still waiting for its conversation, or nothing", () => {
    const { hub, socket, finished, owners, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "error", code: "internal", message: "Erreur interne." });
    expect(finished).toEqual([]);
    expect(owners.at(-1)).toBeUndefined();
    hub.send(message(OTHER_REQUEST), "spotlight");
    socket().receive({ type: "error", code: "internal", message: "Erreur interne." });
    expect(finished).toEqual([{ origin: "spotlight", outcome: "failed", conversationId: undefined, code: "internal", message: "Erreur interne." }]);
    expect(owners.at(-1)).toBe("spotlight");
  });

  test("connection lost mid-turn: the turn fails once, with an explanation, even if the link drops again", () => {
    const { hub, socket, finished, statuses, connectReady, ready, retry } = setup();
    connectReady();
    hub.send(message(), "spotlight");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().onclose?.(1006);
    expect(statuses.at(-1)).toBe("offline");
    expect(finished).toEqual([{ origin: "spotlight", outcome: "failed", conversationId: CONV, message: LOST }]);
    retry();
    ready();
    socket().onclose?.(1006);
    expect(statuses).toEqual(["connecting", "ready", "offline", "connecting", "ready", "offline"]);
    expect(finished).toHaveLength(1);
  });

  test("a refused device fails the pending turn with its own explanation", () => {
    const { hub, socket, finished, statuses, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    socket().onclose?.(4401);
    expect(statuses.at(-1)).toBe("rejected");
    expect(finished).toEqual([
      { origin: "main", outcome: "failed", conversationId: undefined, message: "Cet appareil a été déconnecté d'Alicia." },
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

  test("connecting again replaces the previous connection without passing through offline", () => {
    const { hub, sockets, statuses, connectReady } = setup();
    connectReady();
    hub.connect({ serverUrl: "https://alicia.ts.net", token: "u".repeat(43) });
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(sockets[1]?.url).toBe("wss://alicia.ts.net/ws");
    expect(statuses).toEqual(["connecting", "ready", "connecting"]);
  });

  test("connecting again with turns pending reports them lost (Alicia's mood must not stay busy)", () => {
    const { hub, finished, pendingAfter, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    hub.connect({ serverUrl: "https://alicia.ts.net", token: "u".repeat(43) });
    expect(finished).toEqual([{ origin: "main", outcome: "failed", conversationId: undefined, message: LOST }]);
    expect(pendingAfter).toEqual([0]);
  });

  test("a throwing consumer neither loses turn tracking nor stops the hub", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const finished: FinishedTurn[] = [];
    const { hub, socket, statuses, connectReady } = setup({
      onEvent: () => { throw new Error("window gone"); },
      onSent: () => { throw new Error("presence broken"); },
      onTurnFinished: (turn) => {
        finished.push(turn);
        throw new Error("notification failed");
      },
    });
    connectReady();
    expect(hub.send(message(), "main")).toBe(true);
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Oui" });
    socket().receive(DONE);
    expect(finished).toEqual([{ origin: "main", outcome: "answered", conversationId: CONV, text: "Oui" }]);
    expect(hub.send(message(OTHER_REQUEST), "main")).toBe(true);
    socket().onclose?.(1006);
    expect(statuses.at(-1)).toBe("offline");
    expect(finished).toHaveLength(2);
  });

  test("a throwing status consumer does not stop the reconnection", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, sockets, socket, connectReady, retry } = setup({
      onStatus: (status) => {
        if (status === "offline") throw new Error("broadcast failed");
      },
    });
    connectReady();
    socket().onclose?.(1006);
    expect(hub.status).toBe("offline");
    retry();
    expect(sockets).toHaveLength(2);
  });
});
