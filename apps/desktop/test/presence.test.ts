import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { LISTENING_MS, Presence, SLEEP_AFTER_MS, SUCCESS_MS, TURN_ERROR_MS } from "../src/main/presence.ts";
import type { MascotState } from "../src/shared/mascot.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const DONE: ServerEvent = { type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 };

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
  return { presence, moods, elapse };
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
    presence.sent();
    presence.event({ type: "text_delta", conversationId: CONV, text: "Bonjour" });
    presence.event(DONE);
    elapse(SUCCESS_MS);
    expect(moods).toEqual(["thinking", "speaking", "success", "idle"]);
  });

  test("remembering gives an idea, other tools keep thinking", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.event({ type: "tool_call", conversationId: CONV, callId: "a", tool: "memory_remember" });
    presence.event({ type: "tool_call", conversationId: CONV, callId: "b", tool: "weather" });
    expect(moods).toEqual(["thinking", "idea", "thinking"]);
  });

  test("a second message refused while Alicia answers does not stop the first turn", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.sent();
    presence.event({ type: "error", requestId: "8b2d3c0f-9b5e-4d2f-8c8b-3e6f7a819203", code: "busy", message: "Alicia répond déjà." });
    presence.event({ type: "text_delta", conversationId: CONV, text: "Oui" });
    expect(moods).toEqual(["thinking", "speaking"]);
  });

  test("a failed turn shows its mood for a moment; quota puts her to sleep", () => {
    const { presence, moods, elapse } = setup();
    presence.sent();
    presence.event({ type: "error", code: "engine", message: "Le moteur a échoué." });
    elapse(TURN_ERROR_MS);
    presence.sent();
    presence.event({ type: "error", code: "quota", message: "Quota atteint." });
    expect(moods).toEqual(["thinking", "error", "idle", "thinking", "sleeping"]);
  });

  test("typing makes her listen, but not during a turn", () => {
    const { presence, moods, elapse } = setup();
    presence.typing();
    elapse(LISTENING_MS);
    presence.sent();
    presence.typing();
    expect(moods).toEqual(["listening", "idle", "thinking"]);
  });

  test("connection lost: alert until the brain is back; refused device: error", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.status("offline");
    presence.typing();
    presence.status("connecting");
    presence.status("ready");
    presence.status("rejected");
    expect(moods).toEqual(["thinking", "alert", "idle", "error"]);
  });

  test("the brain coming back does not wake a sleeping Alicia (quota)", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.event({ type: "error", code: "quota", message: "Quota atteint." });
    presence.status("connecting");
    presence.status("ready");
    expect(moods).toEqual(["thinking", "sleeping"]);
  });

  test("the brain coming back does not cut a success or an error short", () => {
    const { presence, moods, elapse } = setup();
    presence.sent();
    presence.event(DONE);
    presence.status("ready");
    elapse(SUCCESS_MS);
    presence.sent();
    presence.event({ type: "error", code: "engine", message: "Le moteur a échoué." });
    presence.status("ready");
    elapse(TURN_ERROR_MS);
    expect(moods).toEqual(["thinking", "success", "idle", "thinking", "error", "idle"]);
  });

  test("events without a turn of ours change nothing", () => {
    const { presence, moods } = setup();
    presence.event({ type: "text_delta", conversationId: CONV, text: "?" });
    presence.event(DONE);
    expect(moods).toEqual([]);
  });
});
