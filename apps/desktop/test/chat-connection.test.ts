import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import {
  ChatConnection, type ConnectionStatus, type SocketLike,
} from "../src/renderer/src/lib/chat-connection.ts";

const TOKEN = "t".repeat(43);
const READY_TIMEOUT_MS = 15_000;
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

interface Timer {
  ms: number;
  run: () => void;
  cancelled: boolean;
}

function setup(onEvent?: (e: ServerEvent) => void) {
  const sockets: FakeSocket[] = [];
  const allTimers: Timer[] = [];
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const connection = new ChatConnection({
    url: "ws://127.0.0.1:8780/ws",
    token: TOKEN,
    openSocket: () => {
      const s = new FakeSocket();
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
    onStatus: (s) => statuses.push(s),
  });
  const timers = {
    /** Reconnect timers only. */
    get retries(): Timer[] {
      return allTimers.filter((t) => t.ms !== READY_TIMEOUT_MS);
    },
    /** Ready-timeout timers only. */
    get ready(): Timer[] {
      return allTimers.filter((t) => t.ms === READY_TIMEOUT_MS);
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
});
