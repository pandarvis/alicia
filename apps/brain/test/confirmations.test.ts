import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { ConfirmationBroker } from "../src/tools/confirmations.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const ASK = { tool: "memory_forget", summary: "Oublier « lasagnes » ?" };
const FIRST = "00000000-0000-4000-8000-000000000000";
const MESSAGE = "9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e";
const WHERE = { conversationId: CONV, messageId: MESSAGE };

function setup(options: { failSend?: (e: ServerEvent) => boolean } = {}) {
  const sent: ServerEvent[] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  let counter = 0;
  const broker = new ConfirmationBroker({
    send: (e) => {
      if (options.failSend?.(e) === true) throw new Error("socket gone");
      sent.push(e);
    },
    newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    now: () => Date.UTC(2026, 9, 5, 10, 0),
    schedule: (run, ms) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  return { broker, sent, timers };
}

describe("ConfirmationBroker", () => {
  test("asks, then the person approves", async () => {
    const { broker, sent, timers } = setup();
    const outcome = broker.ask(WHERE, ASK, new AbortController().signal);
    expect(sent).toEqual([{
      type: "confirm_request", conversationId: CONV, messageId: MESSAGE, confirmationId: FIRST,
      tool: "memory_forget", summary: "Oublier « lasagnes » ?", expiresAt: "2026-10-05T10:05:00.000Z",
    }]);
    expect(timers[0]?.ms).toBe(300_000);
    expect(broker.answer(FIRST, true)).toBe(true);
    expect(await outcome).toBe("approved");
    expect(timers[0]?.cancelled).toBe(true);
    expect(sent[1]).toEqual({ type: "confirm_result", conversationId: CONV, confirmationId: FIRST, outcome: "approved" });
  });

  test("a no is a refusal; a second answer is ignored", async () => {
    const { broker } = setup();
    const outcome = broker.ask(WHERE, ASK, new AbortController().signal);
    expect(broker.answer(FIRST, false)).toBe(true);
    expect(broker.answer(FIRST, true)).toBe(false);
    expect(await outcome).toBe("refused");
  });

  test("no answer within the delay: expired", async () => {
    const { broker, timers, sent } = setup();
    const outcome = broker.ask(WHERE, ASK, new AbortController().signal);
    timers[0]?.run();
    expect(await outcome).toBe("expired");
    expect(sent.at(-1)).toEqual({ type: "confirm_result", conversationId: CONV, confirmationId: FIRST, outcome: "expired" });
    expect(broker.answer(FIRST, true)).toBe(false);
  });

  test("a late answer (after expiry, or a second one) is not an error: the outcome is said again", async () => {
    const { broker, timers, sent } = setup();
    const outcome = broker.ask(WHERE, ASK, new AbortController().signal);
    timers[0]?.run();
    await outcome;
    const count = sent.length;
    expect(broker.answer(FIRST, true)).toBe(false);
    expect(sent.slice(count)).toEqual([{ type: "confirm_result", conversationId: CONV, confirmationId: FIRST, outcome: "expired" }]);
  });

  test("a request that cannot be sent is cancelled at once (never left waiting, never rejected)", async () => {
    const { broker, timers } = setup({ failSend: (e) => e.type === "confirm_request" });
    expect(await broker.ask(WHERE, ASK, new AbortController().signal)).toBe("cancelled");
    expect(timers[0]?.cancelled).toBe(true);
  });

  test("a result that cannot be sent still settles", async () => {
    const { broker } = setup({ failSend: (e) => e.type === "confirm_result" });
    const outcome = broker.ask(WHERE, ASK, new AbortController().signal);
    expect(broker.answer(FIRST, true)).toBe(true);
    expect(await outcome).toBe("approved");
  });

  test("turn aborted (connection lost): cancelled", async () => {
    const { broker, timers } = setup();
    const controller = new AbortController();
    const outcome = broker.ask(WHERE, ASK, controller.signal);
    controller.abort();
    expect(await outcome).toBe("cancelled");
    expect(timers[0]?.cancelled).toBe(true);
  });

  test("already aborted: cancelled without asking", async () => {
    const { broker, sent } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await broker.ask(WHERE, ASK, controller.signal)).toBe("cancelled");
    expect(sent).toEqual([]);
  });

  test("cancelAll settles everything still waiting", async () => {
    const { broker } = setup();
    const a = broker.ask(WHERE, ASK, new AbortController().signal);
    const b = broker.ask(WHERE, ASK, new AbortController().signal);
    broker.cancelAll();
    expect(await Promise.all([a, b])).toEqual(["cancelled", "cancelled"]);
  });

  test("a custom delay", () => {
    const { timers } = setup();
    const broker = new ConfirmationBroker({
      send: () => undefined, newId: () => FIRST, now: () => 0, timeoutMs: 50,
      schedule: (run, ms) => {
        timers.push({ run, ms, cancelled: false });
        return () => undefined;
      },
    });
    void broker.ask(WHERE, ASK, new AbortController().signal);
    expect(timers[0]?.ms).toBe(50);
  });

  test("unknown id: false, and nothing sent", () => {
    const { broker, sent } = setup();
    expect(broker.answer("7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6", true)).toBe(false);
    expect(sent).toEqual([]);
  });
});
