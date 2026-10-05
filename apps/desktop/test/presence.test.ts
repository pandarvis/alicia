import { describe, expect, test } from "vitest";
import type { FinishedTurn } from "../src/main/brain-hub.ts";
import { LISTENING_MS, Presence, SLEEP_AFTER_MS, SUCCESS_MS, TURN_ERROR_MS } from "../src/main/presence.ts";
import type { MascotState } from "../src/shared/mascot.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const ANSWERED: FinishedTurn = { origin: "main", outcome: "answered", conversationId: CONV, text: "Bonjour" };

function failed(code?: "quota" | "engine" | "busy"): FinishedTurn {
  return { origin: "main", outcome: "failed", conversationId: CONV, message: "Raté.", ...(code !== undefined ? { code } : {}) };
}

function setup() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const moods: MascotState[] = [];
  const presence = new Presence({
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    onChange: (mood) => { moods.push(mood); },
  });
  /** Runs the pending timer of that duration. */
  const elapse = (ms: number): void => {
    const timer = timers.find((t) => t.ms === ms && !t.cancelled);
    if (timer === undefined) throw new Error(`no pending ${ms} ms timer`);
    timer.cancelled = true;
    timer.run();
  };
  const pending = (ms: number): boolean => timers.some((t) => t.ms === ms && !t.cancelled);
  return { presence, moods, elapse, pending };
}

describe("Presence", () => {
  test("idle, then asleep after a long quiet time", () => {
    const { presence, moods, elapse } = setup();
    expect(presence.mood).toBe("idle");
    elapse(SLEEP_AFTER_MS);
    expect(moods).toEqual(["sleeping"]);
  });

  test("a turn: thinking, speaking, success, then idle", () => {
    const { presence, moods, elapse } = setup();
    presence.sent(1);
    presence.event({ type: "text_delta", conversationId: CONV, text: "Bonjour" });
    presence.finished(ANSWERED, 0);
    elapse(SUCCESS_MS);
    expect(moods).toEqual(["thinking", "speaking", "success", "idle"]);
  });

  test("remembering gives an idea, other tools keep thinking", () => {
    const { presence, moods } = setup();
    presence.sent(1);
    presence.event({ type: "tool_call", conversationId: CONV, callId: "a", tool: "memory_remember", label: "Alicia retient ça…" });
    presence.event({ type: "tool_call", conversationId: CONV, callId: "b", tool: "weather", label: "Alicia regarde la météo…" });
    expect(moods).toEqual(["thinking", "idea", "thinking"]);
  });

  test("waiting for a yes or no: alert; once answered, back to thinking", () => {
    const { presence, moods } = setup();
    presence.sent(1);
    presence.event({
      type: "confirm_request", conversationId: CONV, confirmationId: CONV, tool: "memory_forget",
      summary: "Oublier ?", expiresAt: "2026-10-05T10:05:00.000Z",
    });
    presence.event({ type: "confirm_result", conversationId: CONV, confirmationId: CONV, outcome: "refused" });
    expect(moods).toEqual(["thinking", "alert", "thinking"]);
  });

  test("a second message while Alicia answers neither interrupts her speech nor ends the first turn when refused", () => {
    const { presence, moods } = setup();
    presence.sent(1);
    presence.event({ type: "text_delta", conversationId: CONV, text: "Oui" });
    presence.sent(2);
    presence.finished(failed("busy"), 1);
    presence.event({ type: "text_delta", conversationId: CONV, text: ", bien sûr" });
    expect(moods).toEqual(["thinking", "speaking"]);
  });

  test("a failed turn shows its mood for a moment", () => {
    const { presence, moods, elapse } = setup();
    presence.sent(1);
    presence.finished(failed("engine"), 0);
    elapse(TURN_ERROR_MS);
    presence.sent(1);
    presence.finished(failed(), 0);
    elapse(TURN_ERROR_MS);
    expect(moods).toEqual(["thinking", "error", "idle", "thinking", "alert", "idle"]);
  });

  test("quota puts her to sleep until a turn succeeds again", () => {
    const { presence, moods, pending } = setup();
    presence.sent(1);
    presence.finished(failed("quota"), 0);
    expect(pending(TURN_ERROR_MS)).toBe(false);
    presence.typing();
    presence.status("connecting");
    presence.status("ready");
    expect(moods).toEqual(["thinking", "sleeping"]);
    presence.sent(1);
    presence.finished(ANSWERED, 0);
    expect(moods).toEqual(["thinking", "sleeping", "thinking", "success"]);
  });

  test("typing makes her listen, but not during a turn", () => {
    const { presence, moods, elapse } = setup();
    presence.typing();
    elapse(LISTENING_MS);
    presence.sent(1);
    presence.typing();
    expect(moods).toEqual(["listening", "idle", "thinking"]);
  });

  test("connection lost: alert until the brain is back, the lost turn does not change that; refused device: error", () => {
    const { presence, moods, pending } = setup();
    presence.sent(1);
    presence.status("offline");
    presence.finished(failed(), 0);
    expect(pending(TURN_ERROR_MS)).toBe(false);
    presence.typing();
    presence.status("connecting");
    presence.status("ready");
    presence.status("rejected");
    expect(moods).toEqual(["thinking", "alert", "idle", "error"]);
  });

  test("the brain coming back does not cut a success or an error short", () => {
    const { presence, moods, elapse } = setup();
    presence.sent(1);
    presence.finished(ANSWERED, 0);
    presence.status("ready");
    elapse(SUCCESS_MS);
    presence.sent(1);
    presence.finished(failed("engine"), 0);
    presence.status("ready");
    elapse(TURN_ERROR_MS);
    expect(moods).toEqual(["thinking", "success", "idle", "thinking", "error", "idle"]);
  });

  test("signing out leaves her idle, not alert", () => {
    const { presence, moods } = setup();
    presence.sent(1);
    presence.signedOut();
    presence.status("connecting");
    presence.status("ready");
    expect(moods).toEqual(["thinking", "idle"]);
    presence.typing();
    expect(moods.at(-1)).toBe("listening");
  });

  test("events without a turn of ours change nothing", () => {
    const { presence, moods } = setup();
    presence.event({ type: "text_delta", conversationId: CONV, text: "?" });
    presence.event({ type: "tool_call", conversationId: CONV, callId: "c", tool: "weather", label: "Alicia regarde la météo…" });
    expect(moods).toEqual([]);
  });
});
