import { describe, expect, test } from "vitest";
import {
  ClientMessage,
  ConversationSummary,
  PairingRequest,
  Person,
  PersonId,
  ServerEvent,
} from "../src/index.ts";

const UUID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

describe("identity", () => {
  test("accepts a valid person", () => {
    expect(Person.parse({ id: "kevin", name: "Kévin" })).toEqual({ id: "kevin", name: "Kévin" });
  });
  test("rejects an id with uppercase letters or accents", () => {
    expect(Person.safeParse({ id: "Élodie", name: "Élodie" }).success).toBe(false);
  });
  test("rejects an id that is too short", () => {
    expect(PersonId.safeParse("a").success).toBe(false);
  });
  test("rejects an id with an underscore", () => {
    expect(PersonId.safeParse("kevin_").success).toBe(false);
  });
});

describe("client messages", () => {
  test("accepts a minimal send", () => {
    const m = ClientMessage.parse({ type: "send", requestId: UUID, text: "Bonjour" });
    expect(m.type).toBe("send");
  });
  test("accepts a full send", () => {
    const m = ClientMessage.parse({
      type: "send", requestId: UUID, conversationId: UUID, text: "Salut", model: "opus",
    });
    expect(m).toMatchObject({ conversationId: UUID, model: "opus" });
  });
  test("rejects an empty text (whitespace only)", () => {
    expect(ClientMessage.safeParse({ type: "send", requestId: UUID, text: "   " }).success).toBe(false);
  });
  test("keeps the text's leading whitespace", () => {
    const m = ClientMessage.parse({ type: "send", requestId: UUID, text: "  Bonjour" });
    expect(m).toMatchObject({ text: "  Bonjour" });
  });
  test("accepts 20,000 characters and rejects 20,001", () => {
    expect(
      ClientMessage.safeParse({ type: "send", requestId: UUID, text: "a".repeat(20_000) }).success,
    ).toBe(true);
    expect(
      ClientMessage.safeParse({ type: "send", requestId: UUID, text: "a".repeat(20_001) }).success,
    ).toBe(false);
  });
  test("rejects an unknown model", () => {
    expect(
      ClientMessage.safeParse({ type: "send", requestId: UUID, text: "x", model: "gpt" }).success,
    ).toBe(false);
  });
  test("rejects an unknown key in a send", () => {
    expect(
      ClientMessage.safeParse({ type: "send", requestId: UUID, text: "x", admin: true }).success,
    ).toBe(false);
  });
  test("accepts authentication", () => {
    expect(ClientMessage.parse({ type: "authenticate", token: "a".repeat(43) }).type).toBe("authenticate");
  });
  test("rejects a 19-character token", () => {
    expect(ClientMessage.safeParse({ type: "authenticate", token: "a".repeat(19) }).success).toBe(false);
  });
  test("rejects an unknown key in authentication", () => {
    expect(
      ClientMessage.safeParse({ type: "authenticate", token: "a".repeat(43), admin: true }).success,
    ).toBe(false);
  });
  test("rejects an unknown type", () => {
    expect(ClientMessage.safeParse({ type: "pirater" }).success).toBe(false);
  });
});

describe("server events", () => {
  const events: unknown[] = [
    { type: "ready", person: { id: "kevin", name: "Kévin" } },
    { type: "conversation", requestId: UUID, conversationId: UUID },
    { type: "text_delta", conversationId: UUID, text: "Bon" },
    { type: "tool_call", conversationId: UUID, callId: "t1", tool: "weather" },
    { type: "tool_result", conversationId: UUID, callId: "t1", success: true },
    { type: "done", conversationId: UUID, model: "sonnet", inputTokens: 10, outputTokens: 5, durationMs: 900 },
    { type: "error", code: "quota", message: "Je me repose." },
  ];
  test.each(events)("accepts the event %j", (e) => {
    expect(ServerEvent.safeParse(e).success).toBe(true);
  });
  test("rejects negative tokens", () => {
    expect(
      ServerEvent.safeParse({
        type: "done", conversationId: UUID, model: "sonnet", inputTokens: -1, outputTokens: 0, durationMs: 0,
      }).success,
    ).toBe(false);
  });
  test("rejects non-integer tokens", () => {
    expect(
      ServerEvent.safeParse({
        type: "done", conversationId: UUID, model: "sonnet", inputTokens: 1.5, outputTokens: 0, durationMs: 0,
      }).success,
    ).toBe(false);
  });
  test("accepts the busy error code", () => {
    expect(ServerEvent.safeParse({ type: "error", code: "busy", message: "x" }).success).toBe(true);
  });
  test("rejects an unknown error code", () => {
    expect(ServerEvent.safeParse({ type: "error", code: "bizarre", message: "x" }).success).toBe(false);
  });
});

describe("HTTP", () => {
  test("the pairing code is exactly 6 digits", () => {
    expect(PairingRequest.safeParse({ code: "123456", deviceName: "PC Kévin" }).success).toBe(true);
    expect(PairingRequest.safeParse({ code: "12345", deviceName: "PC" }).success).toBe(false);
    expect(PairingRequest.safeParse({ code: "12345a", deviceName: "PC" }).success).toBe(false);
  });
  test("rejects an unknown key in the pairing request", () => {
    expect(
      PairingRequest.safeParse({ code: "123456", deviceName: "PC", admin: true }).success,
    ).toBe(false);
  });
  test("rejects a non-ISO date in a conversation summary", () => {
    expect(ConversationSummary.safeParse({ id: UUID, title: "t", updatedAt: "yesterday" }).success).toBe(false);
    expect(
      ConversationSummary.safeParse({ id: UUID, title: "t", updatedAt: "2026-10-04T12:00:00Z" }).success,
    ).toBe(true);
  });
});
