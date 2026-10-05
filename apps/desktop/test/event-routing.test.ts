import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { confirmationSurface, eventRecipients, mayReadSession } from "../src/main/event-routing.ts";
import type { Surface } from "../src/shared/surface.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const REQUEST = "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const OPEN: readonly Surface[] = ["main", "holo", "spotlight"];

const TURN_EVENTS: ServerEvent[] = [
  { type: "conversation", requestId: REQUEST, conversationId: CONV },
  { type: "text_delta", conversationId: CONV, text: "Bonjour" },
  { type: "tool_call", conversationId: CONV, callId: "c", tool: "weather", label: "Alicia regarde la météo…" },
  { type: "tool_result", conversationId: CONV, callId: "c", success: true },
  {
    type: "confirm_request", conversationId: CONV, messageId: CONV, confirmationId: REQUEST, tool: "memory_forget",
    summary: "Oublier ce souvenir ?", expiresAt: "2026-10-05T10:05:00.000Z",
  },
  { type: "confirm_result", conversationId: CONV, confirmationId: REQUEST, outcome: "approved" },
  { type: "error", requestId: REQUEST, code: "engine", message: "Raté." },
];
const DONE: ServerEvent = { type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 };

describe("mayReadSession", () => {
  test("the device token only reaches the windows that call the brain over HTTP", () => {
    expect(OPEN.filter(mayReadSession)).toEqual(["main", "holo"]);
  });
});

describe("eventRecipients", () => {
  test("a turn's events go to the window that asked, and only to it", () => {
    for (const event of TURN_EVENTS) {
      expect(eventRecipients(event, "holo", OPEN), event.type).toEqual(["holo"]);
    }
  });

  test("a turn's events of no known window go nowhere", () => {
    for (const event of TURN_EVENTS) {
      expect(eventRecipients(event, undefined, OPEN), event.type).toEqual([]);
    }
  });

  test("the end of a turn reaches every window, so their conversation lists stay current", () => {
    expect(eventRecipients(DONE, "holo", OPEN)).toEqual(OPEN);
    expect(eventRecipients(DONE, undefined, OPEN)).toEqual(OPEN);
  });

  test("connection events reach every window", () => {
    expect(eventRecipients({ type: "ready", person: { id: "kevin", name: "Kévin" } }, undefined, OPEN)).toEqual(OPEN);
  });

  test("a window that is not open receives nothing", () => {
    expect(eventRecipients(TURN_EVENTS[1] ?? DONE, "spotlight", ["main"])).toEqual([]);
  });
});

describe("confirmationSurface", () => {
  test("a card shows in the window whose turn asked; the Spotlight bar cannot show one: the main window does", () => {
    expect(confirmationSurface("main")).toBe("main");
    expect(confirmationSurface("holo")).toBe("holo");
    expect(confirmationSurface("spotlight")).toBe("main");
  });

  test("a Spotlight turn's confirmation events go to the main window", () => {
    for (const event of TURN_EVENTS.filter((e) => e.type === "confirm_request" || e.type === "confirm_result")) {
      expect(eventRecipients(event, "spotlight", OPEN), event.type).toEqual(["main"]);
    }
    expect(eventRecipients(TURN_EVENTS[1] ?? DONE, "spotlight", OPEN)).toEqual(["spotlight"]);
  });

  test("a Spotlight turn that fails in a conversation also tells the main window (its cards there are over)", () => {
    const failed: ServerEvent = { type: "error", requestId: REQUEST, conversationId: CONV, code: "engine", message: "Raté." };
    expect(eventRecipients(failed, "spotlight", OPEN)).toEqual(["spotlight", "main"]);
    expect(eventRecipients(failed, "spotlight", ["main"])).toEqual(["main"]);
    expect(eventRecipients(failed, "holo", OPEN)).toEqual(["holo"]);
    // Refused before any conversation: nothing waits in the main window.
    expect(eventRecipients({ type: "error", requestId: REQUEST, code: "busy", message: "Occupée." }, "spotlight", OPEN)).toEqual(["spotlight"]);
  });
});
