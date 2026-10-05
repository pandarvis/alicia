import { describe, expect, test } from "vitest";
import {
  ClientMessage,
  ConversationSummary,
  HistoryMessage,
  HttpErrorBody,
  MEMORY_KINDS,
  MemoryPatch,
  MemorySummary,
  MemoryTestHit,
  PairingRequest,
  Person,
  PersonId,
  ServerEvent,
} from "../src/index.ts";

const UUID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const CONFIRMATION = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";

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
    expect(ClientMessage.safeParse({ type: "hack" }).success).toBe(false);
  });
  test("confirm: a strict client message", () => {
    const message = { type: "confirm", confirmationId: CONFIRMATION, approved: true };
    expect(ClientMessage.parse(message)).toEqual(message);
    expect(ClientMessage.safeParse({ ...message, approved: "oui" }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...message, confirmationId: "nope" }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...message, extra: 1 }).success).toBe(false);
  });
});

describe("server events", () => {
  const events: unknown[] = [
    { type: "ready", person: { id: "kevin", name: "Kévin" } },
    { type: "conversation", requestId: UUID, conversationId: UUID },
    { type: "text_delta", conversationId: UUID, text: "Bon" },
    { type: "tool_call", conversationId: UUID, callId: "t1", tool: "weather", label: "Alicia regarde la météo…" },
    { type: "tool_result", conversationId: UUID, callId: "t1", success: true },
    { type: "done", conversationId: UUID, model: "sonnet", inputTokens: 10, outputTokens: 5, durationMs: 900 },
    { type: "error", code: "quota", message: "Je me repose." },
  ];
  test.each(events)("accepts the event %j", (e) => {
    expect(ServerEvent.safeParse(e).success).toBe(true);
  });
  test("heartbeat", () => {
    expect(ServerEvent.parse({ type: "heartbeat" })).toEqual({ type: "heartbeat" });
  });
  test("confirm_request and confirm_result round-trip", () => {
    const request = {
      type: "confirm_request", conversationId: UUID, messageId: UUID, confirmationId: CONFIRMATION,
      tool: "memory_forget", summary: "Oublier ce souvenir : « Kévin adore les lasagnes » ?",
      expiresAt: "2026-10-05T10:05:00.000Z",
    };
    expect(ServerEvent.parse(request)).toEqual(request);
    expect(ServerEvent.safeParse({ ...request, summary: "x".repeat(501) }).success).toBe(false);
    expect(ServerEvent.safeParse({ ...request, summary: "" }).success).toBe(false);
    expect(ServerEvent.safeParse({ ...request, messageId: undefined }).success).toBe(false);
    for (const outcome of ["approved", "refused", "expired", "cancelled"]) {
      const result = { type: "confirm_result", conversationId: UUID, confirmationId: CONFIRMATION, outcome };
      expect(ServerEvent.parse(result)).toEqual(result);
    }
    expect(
      ServerEvent.safeParse({ type: "confirm_result", conversationId: UUID, confirmationId: CONFIRMATION, outcome: "maybe" }).success,
    ).toBe(false);
  });
  test("tool_call carries a French label", () => {
    const event = { type: "tool_call", conversationId: UUID, callId: "t1", tool: "weather", label: "Alicia regarde la météo…" };
    expect(ServerEvent.parse(event)).toEqual(event);
    expect(ServerEvent.safeParse({ ...event, label: undefined }).success).toBe(false);
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

describe("HTTP errors", () => {
  test("a plain error and a refused memory", () => {
    expect(HttpErrorBody.safeParse({ error: { code: "not_found", message: "Introuvable." } }).success).toBe(true);
    for (const code of ["too_large", "unsupported", "empty"]) {
      expect(HttpErrorBody.safeParse({ error: { code, message: "…" } }).success, code).toBe(true);
    }
    expect(
      HttpErrorBody.safeParse({ error: { code: "refused", message: "Souvenir refusé.", reason: "secret" } }).success,
    ).toBe(true);
  });
  test("a refusal needs its reason; unknown codes and the old flat shape are rejected", () => {
    expect(HttpErrorBody.safeParse({ error: { code: "refused", message: "x" } }).success).toBe(false);
    expect(HttpErrorBody.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(HttpErrorBody.safeParse({ error: "not_found" }).success).toBe(false);
  });
});

describe("memory", () => {
  test("five kinds", () => {
    expect(MEMORY_KINDS).toEqual(["rule", "preference", "habit", "fact", "event"]);
  });
  const SUMMARY = {
    id: UUID, scope: "personal", kind: "preference", text: "Aime les lasagnes",
    pinned: false, source: "conversation", conversationId: "7d9e1a52-3c4b-4f60-8a1d-0b2c3d4e5f60",
    conversationTitle: "Dîner", createdAt: "2026-10-04T13:30:00.000Z", updatedAt: "2026-10-04T13:30:00.000Z",
    recallCount: 2, lastRecalledAt: "2026-10-04T14:00:00.000Z", forgottenAt: null,
  };
  test("summary", () => {
    expect(MemorySummary.safeParse(SUMMARY).success).toBe(true);
    expect(MemorySummary.safeParse({
      ...SUMMARY, source: "manual", conversationId: null, conversationTitle: null, lastRecalledAt: null,
      forgottenAt: "2026-10-05T08:00:00.000Z",
    }).success).toBe(true);
  });
  test("summary needs its provenance and usage fields, typed", () => {
    expect(MemorySummary.safeParse({ ...SUMMARY, source: "dream" }).success).toBe(false);
    expect(MemorySummary.safeParse({ ...SUMMARY, conversationId: "not-a-uuid" }).success).toBe(false);
    expect(MemorySummary.safeParse({ ...SUMMARY, forgottenAt: "yesterday" }).success).toBe(false);
    expect(MemorySummary.safeParse(Object.fromEntries(Object.entries(SUMMARY).filter(([key]) => key !== "source"))).success).toBe(false);
  });
  test("test hit", () => {
    const hit = { memory: SUMMARY, rank: 1, textMatch: true, similarity: 0.87 };
    expect(MemoryTestHit.safeParse(hit).success).toBe(true);
    expect(MemoryTestHit.safeParse({ ...hit, rank: 0 }).success).toBe(false);
    expect(MemoryTestHit.safeParse({ ...hit, similarity: 1.2 }).success).toBe(false);
  });
  test("patch is strict and bounded", () => {
    expect(MemoryPatch.safeParse({ pinned: true }).success).toBe(true);
    expect(MemoryPatch.safeParse({ text: "" }).success).toBe(false);
    expect(MemoryPatch.safeParse({ scope: "elodie" }).success).toBe(false);
    expect(MemoryPatch.safeParse({ admin: true }).success).toBe(false);
  });
  test("an empty patch changes nothing and is refused", () => {
    expect(MemoryPatch.safeParse({}).success).toBe(false);
  });
});

describe("HistoryMessage", () => {
  test("history messages carry their attachments", () => {
    const base = { id: "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", role: "user", text: "Regarde", createdAt: "2026-10-05T10:00:00.000Z" };
    expect(HistoryMessage.safeParse(base).success).toBe(false);
    expect(HistoryMessage.parse({ ...base, attachments: [] }).attachments).toEqual([]);
    const file = { id: "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6", name: "facture.pdf", kind: "pdf", size: 3 };
    expect(HistoryMessage.parse({ ...base, attachments: [file] }).attachments).toEqual([file]);
    expect(HistoryMessage.safeParse({ ...base, attachments: [{ ...file, path: "C:/x.pdf", kind: "exe" }] }).success).toBe(false);
  });
});
