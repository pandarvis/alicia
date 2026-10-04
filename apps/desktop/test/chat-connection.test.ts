import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import {
  ChatConnection, type ConnectionStatus, type SocketLike,
} from "../src/renderer/src/lib/chat-connection.ts";

const TOKEN = "t".repeat(43);

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

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { ms: number; run: () => void }[] = [];
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
      timers.push({ run, ms });
      return () => undefined;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
  });
  return { connection, sockets, timers, events, statuses };
}

describe("ChatConnection", () => {
  test("authenticates on open and becomes ready", () => {
    const { connection, sockets, statuses } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: "authenticate", token: TOKEN })]);
    sockets[0]?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    expect(statuses).toEqual(["connecting", "ready"]);
  });

  test("forwards valid events and drops invalid ones", () => {
    const { connection, sockets, events } = setup();
    connection.start();
    sockets[0]?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    sockets[0]?.receive({ type: "nonsense" });
    sockets[0]?.onmessage?.("not json");
    expect(events.map((e) => e.type)).toEqual(["ready"]);
  });

  test("send only works once ready", () => {
    const { connection, sockets } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    const message = { type: "send" as const, requestId: "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", text: "Salut" };
    expect(connection.send(message)).toBe(false);
    sockets[0]?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    expect(connection.send(message)).toBe(true);
    expect(sockets[0]?.sent.at(-1)).toBe(JSON.stringify(message));
  });

  test("reconnects with growing delays, capped at 30 s, reset after ready", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    for (let i = 0; i < 7; i++) {
      sockets.at(-1)?.onclose?.(1006);
      timers.at(-1)?.run();
    }
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(statuses).toContain("offline");
    sockets.at(-1)?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    sockets.at(-1)?.onclose?.(1006);
    expect(timers.at(-1)?.ms).toBe(1000);
  });

  test("4401 (device refused) stops for good", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.onclose?.(4401);
    expect(statuses.at(-1)).toBe("rejected");
    expect(timers).toHaveLength(0);
  });

  test("stop closes the socket and never reconnects", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    connection.stop();
    expect(sockets[0]?.closedWith).toBe(1000);
    sockets[0]?.onclose?.(1000);
    expect(timers).toHaveLength(0);
  });
});
