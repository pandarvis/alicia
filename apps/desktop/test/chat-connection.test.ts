import type { ServerEvent } from "@alicia/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ChatConnection, ConnectionStatus, type SocketLike, webSocketUrl,
} from "../src/shared/chat-connection.ts";

const TOKEN = "t".repeat(43);
const READY_TIMEOUT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 75_000;
const READY = { type: "ready", person: { id: "kevin", name: "Kévin" } };
const CONVERSATION_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const MESSAGE = { type: "send" as const, requestId: "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", text: "Salut" };

/** Fake socket driven by the test. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  readonly #closeFiresAtOnce: boolean;
  /** `closeFiresAtOnce`: close() reports the close event synchronously, as some implementations do. */
  constructor(closeFiresAtOnce = false) {
    this.#closeFiresAtOnce = closeFiresAtOnce;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
    if (this.#closeFiresAtOnce) this.onclose?.(code ?? 1005);
  }
  receive(event: unknown): void {
    this.onmessage?.(JSON.stringify(event));
  }
}

interface Timer {
  ms: number;
  run: () => void;
  cancelled: boolean;
}

function setup(
  onEvent?: (e: ServerEvent) => void,
  options: { closeFiresAtOnce?: boolean; onStatus?: (s: ConnectionStatus) => void } = {},
) {
  const sockets: FakeSocket[] = [];
  const allTimers: Timer[] = [];
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const connection = new ChatConnection({
    url: "ws://127.0.0.1:8780/ws",
    token: TOKEN,
    openSocket: () => {
      const s = new FakeSocket(options.closeFiresAtOnce === true);
      sockets.push(s);
      return s;
    },
    schedule: (run, ms) => {
      const timer: Timer = { run, ms, cancelled: false };
      allTimers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onEvent: (e) => {
      events.push(e);
      onEvent?.(e);
    },
    onStatus: (s) => {
      statuses.push(s);
      options.onStatus?.(s);
    },
  });
  const timers = {
    /** Reconnect timers only. */
    get retries(): Timer[] {
      return allTimers.filter((t) => t.ms !== READY_TIMEOUT_MS && t.ms !== HEARTBEAT_TIMEOUT_MS);
    },
    /** Ready-timeout timers only. */
    get ready(): Timer[] {
      return allTimers.filter((t) => t.ms === READY_TIMEOUT_MS);
    },
    /** Heartbeat watchdogs only. */
    get heartbeats(): Timer[] {
      return allTimers.filter((t) => t.ms === HEARTBEAT_TIMEOUT_MS);
    },
  };
  return { connection, sockets, timers, events, statuses };
}

describe("ChatConnection", () => {
  test("authenticates on open and becomes ready", () => {
    const { connection, sockets, statuses } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: "authenticate", token: TOKEN })]);
    sockets[0]?.receive(READY);
    expect(statuses).toEqual(["connecting", "ready"]);
  });

  test("forwards valid events and drops invalid ones", () => {
    const { connection, sockets, events } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    sockets[0]?.receive({ type: "nonsense" });
    sockets[0]?.onmessage?.("not json");
    expect(events.map((e) => e.type)).toEqual(["ready"]);
  });

  test("send only works once ready", () => {
    const { connection, sockets } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    expect(connection.send(MESSAGE)).toBe(false);
    sockets[0]?.receive(READY);
    expect(connection.send(MESSAGE)).toBe(true);
    expect(sockets[0]?.sent.at(-1)).toBe(JSON.stringify(MESSAGE));
  });

  test("sends a confirm answer once ready", () => {
    const { connection, sockets } = setup();
    const answer = { type: "confirm" as const, confirmationId: "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6", approved: false };
    connection.start();
    sockets[0]?.onopen?.();
    expect(connection.send(answer)).toBe(false);
    sockets[0]?.receive(READY);
    expect(connection.send(answer)).toBe(true);
    expect(sockets[0]?.sent.at(-1)).toBe(JSON.stringify(answer));
  });

  test("reconnects with growing delays, capped at 30 s, reset after ready", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    for (let i = 0; i < 7; i++) {
      sockets.at(-1)?.onclose?.(1006);
      timers.retries.at(-1)?.run();
    }
    expect(timers.retries.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(statuses).toContain("offline");
    sockets.at(-1)?.receive(READY);
    sockets.at(-1)?.onclose?.(1006);
    expect(timers.retries.at(-1)?.ms).toBe(1000);
  });

  test("4401 (device refused) stops for good", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.onclose?.(4401);
    expect(statuses.at(-1)).toBe("rejected");
    expect(timers.retries).toHaveLength(0);
  });

  test("stop closes the socket and never reconnects", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    connection.stop();
    expect(sockets[0]?.closedWith).toBe(1000);
    sockets[0]?.onclose?.(1000);
    expect(timers.retries).toHaveLength(0);
  });

  test("start is idempotent while a socket exists", () => {
    const { connection, sockets } = setup();
    connection.start();
    connection.start();
    expect(sockets).toHaveLength(1);
  });

  test("a stale socket's late close is ignored", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    connection.stop();
    connection.start();
    const before = statuses.length;
    sockets[0]?.onclose?.(1006);
    expect(timers.retries).toHaveLength(0);
    expect(statuses).toHaveLength(before);
    sockets[1]?.receive(READY);
    expect(connection.send(MESSAGE)).toBe(true);
    expect(sockets[1]?.sent.at(-1)).toBe(JSON.stringify(MESSAGE));
  });

  test("a stale socket's open and messages are ignored", () => {
    const { connection, sockets, events } = setup();
    connection.start();
    connection.stop();
    connection.start();
    sockets[0]?.onopen?.();
    sockets[0]?.receive(READY);
    expect(sockets[0]?.sent).toEqual([]);
    expect(events).toEqual([]);
  });

  test("start cancels a pending reconnect instead of doubling the loop", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]?.onclose?.(1006);
    connection.start();
    expect(sockets).toHaveLength(2);
    timers.retries[0]?.run();
    expect(sockets).toHaveLength(2);
  });

  test("stop resets state so send fails and timers are cancelled", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    connection.stop();
    expect(connection.send(MESSAGE)).toBe(false);
    expect(timers.ready.every((t) => t.cancelled)).toBe(true);
  });

  test("closes the socket if ready does not arrive in time", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    expect(timers.ready).toHaveLength(1);
    timers.ready[0]?.run();
    expect(sockets[0]?.closedWith).toBe(4000);
    sockets[0]?.onclose?.(4000);
    expect(statuses.at(-1)).toBe("offline");
    expect(timers.retries.map((t) => t.ms)).toEqual([1000]);
  });

  test("stop before ready cancels the ready timeout", () => {
    const { connection, timers } = setup();
    connection.start();
    connection.stop();
    expect(timers.ready[0]?.cancelled).toBe(true);
  });

  test("ready cancels the ready timeout", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    expect(timers.ready[0]?.cancelled).toBe(true);
  });

  test("a throwing onEvent does not break the connection", () => {
    let calls = 0;
    const { connection, sockets, events } = setup(() => {
      if (calls++ === 0) throw new Error("boom");
    });
    connection.start();
    sockets[0]?.receive(READY);
    sockets[0]?.receive({ type: "text_delta", conversationId: CONVERSATION_ID, text: "Bonjour" });
    expect(events.map((e) => e.type)).toEqual(["ready", "text_delta"]);
  });

  test("silence after ready: the socket is given up and a reconnect is scheduled at once", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    expect(timers.heartbeats).toHaveLength(1);
    timers.heartbeats[0]?.run();
    expect(sockets[0]?.closedWith).toBe(4001);
    expect(statuses.at(-1)).toBe("offline");
    expect(connection.send(MESSAGE)).toBe(false);
    expect(timers.retries.map((t) => t.ms)).toEqual([1000]);
    // The late close of the abandoned socket changes nothing.
    sockets[0]?.onclose?.(1006);
    expect(timers.retries).toHaveLength(1);
    timers.retries[0]?.run();
    expect(sockets).toHaveLength(2);
  });

  test("ready timeout: the socket is lost at once, without waiting for its close event", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    timers.ready[0]?.run();
    expect(sockets[0]?.closedWith).toBe(4000);
    expect(statuses.at(-1)).toBe("offline");
    expect(timers.retries.map((t) => t.ms)).toEqual([1000]);
  });

  test("ready timeout with a socket that reports its close synchronously: a single reconnect", () => {
    const { connection, sockets, timers } = setup(undefined, { closeFiresAtOnce: true });
    connection.start();
    sockets[0]?.onopen?.();
    timers.ready[0]?.run();
    expect(timers.retries).toHaveLength(1);
  });

  test("silent brain with a socket that reports its close synchronously: a single reconnect", () => {
    const { connection, sockets, timers } = setup(undefined, { closeFiresAtOnce: true });
    connection.start();
    sockets[0]?.receive(READY);
    timers.heartbeats[0]?.run();
    expect(timers.retries).toHaveLength(1);
  });

  test("any frame re-arms the watchdog, even one that cannot be read", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    sockets[0]?.onmessage?.("pas du JSON");
    expect(timers.heartbeats).toHaveLength(2);
    expect(timers.heartbeats[0]?.cancelled).toBe(true);
    sockets[0]?.receive({ type: "nonsense" });
    expect(timers.heartbeats).toHaveLength(3);
  });

  test("every message re-arms the watchdog; heartbeats are not forwarded", () => {
    const { connection, sockets, timers, events } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    sockets[0]?.receive({ type: "heartbeat" });
    expect(events.map((e) => e.type)).toEqual(["ready"]);
    expect(timers.heartbeats).toHaveLength(2);
    expect(timers.heartbeats[0]?.cancelled).toBe(true);
    expect(timers.heartbeats[1]?.cancelled).toBe(false);
  });

  test("no watchdog before ready; a close or stop cancels it", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    sockets[0]?.receive({ type: "heartbeat" });
    expect(timers.heartbeats).toHaveLength(0);
    sockets[0]?.receive(READY);
    sockets[0]?.onclose?.(1006);
    expect(timers.heartbeats.every((t) => t.cancelled)).toBe(true);
    timers.retries.at(-1)?.run();
    sockets.at(-1)?.receive(READY);
    connection.stop();
    expect(timers.heartbeats.every((t) => t.cancelled)).toBe(true);
  });
});

describe("webSocketUrl", () => {
  test("derives the WebSocket URL", () => {
    expect(webSocketUrl("http://127.0.0.1:8780")).toBe("ws://127.0.0.1:8780/ws");
    expect(webSocketUrl("https://alicia.ts.net")).toBe("wss://alicia.ts.net/ws");
    expect(webSocketUrl("https://host/alicia")).toBe("wss://host/alicia/ws");
  });
});

describe("ConnectionStatus", () => {
  test("the four states, validated at boundaries", () => {
    expect(ConnectionStatus.options).toEqual(["connecting", "ready", "offline", "rejected"]);
    expect(ConnectionStatus.safeParse("lost").success).toBe(false);
  });
});

describe("ChatConnection with a faulty status consumer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a throwing status handler cannot stop the reconnection", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { connection, sockets, timers, statuses } = setup(undefined, {
      onStatus: () => {
        throw new Error("consumer broke");
      },
    });
    connection.start();
    sockets[0]?.receive(READY);
    sockets[0]?.onclose?.(1006);
    expect(statuses).toEqual(["connecting", "ready", "offline"]);
    expect(timers.retries).toHaveLength(1);
    timers.retries[0]?.run();
    expect(sockets).toHaveLength(2);
  });
});
