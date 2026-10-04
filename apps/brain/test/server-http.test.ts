import { describe, expect, test, vi } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import { createServer } from "../src/server/server.ts";
import { createTestClock, createTestDb, createTestMemory } from "./helpers.ts";

async function createContext() {
  const db = createTestDb();
  const time = createTestClock();
  const repository = new ConversationRepository(db, time.clock);
  const pairing = new PairingService(db, time.clock);
  const engine = new FakeEngine(() => [{ type: "done", inputTokens: 0, outputTokens: 0 }]);
  const app = await createServer({
    pairing, repository, version: "0.1.0", chat: {
      repository, engine, memory: createTestMemory(db, time.clock), clock: time.clock, timezone: "Europe/Paris",
    },
  });
  return { app, pairing, repository };
}

async function pair(ctx: Awaited<ReturnType<typeof createContext>>, person: string) {
  const code = ctx.pairing.generateCode(person);
  const res = await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code, deviceName: "PC" } });
  return res.json<{ token: string }>().token;
}

describe("HTTP server", () => {
  test("GET /health", async () => {
    const { app } = await createContext();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("POST /pairing: valid code → token and person", async () => {
    const ctx = await createContext();
    const code = ctx.pairing.generateCode("kevin");
    const res = await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code, deviceName: "PC" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ person: { id: "kevin", name: "Kévin" } });
  });

  test("POST /pairing: invalid body → 400, wrong code → 401", async () => {
    const { app } = await createContext();
    expect((await app.inject({ method: "POST", url: "/pairing", payload: { code: "abc" } })).statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: "/pairing", payload: { code: "000000", deviceName: "PC" } });
    expect(res.statusCode).toBe(401);
  });

  test("GET /conversations: 401 without a token, isolated list with a token", async () => {
    const ctx = await createContext();
    expect((await ctx.app.inject({ method: "GET", url: "/conversations" })).statusCode).toBe(401);
    ctx.repository.create("kevin", "À Kévin");
    ctx.repository.create("elodie", "À Élodie");
    const token = await pair(ctx, "kevin");
    const res = await ctx.app.inject({
      method: "GET", url: "/conversations", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json<{ title: string }[]>().map((c) => c.title)).toEqual(["À Kévin"]);
  });

  test("GET /conversations/:id/messages: 404 on someone else's conversation", async () => {
    const ctx = await createContext();
    const c = ctx.repository.create("elodie", "Privé");
    ctx.repository.addMessage(c.id, "user", "secret");
    const token = await pair(ctx, "kevin");
    const res = await ctx.app.inject({
      method: "GET", url: `/conversations/${c.id}/messages`, headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  test("GET /conversations/:id/messages: history with ISO dates", async () => {
    const ctx = await createContext();
    const c = ctx.repository.create("kevin", "T");
    ctx.repository.addMessage(c.id, "user", "Bonjour");
    const token = await pair(ctx, "kevin");
    const res = await ctx.app.inject({
      method: "GET", url: `/conversations/${c.id}/messages`, headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual([
      { id: expect.any(String) as string, role: "user", text: "Bonjour", createdAt: "2026-10-04T13:30:00.000Z" },
    ]);
  });

  test("case-insensitive Bearer scheme (RFC 7235)", async () => {
    const ctx = await createContext();
    const token = await pair(ctx, "kevin");
    const res = await ctx.app.inject({
      method: "GET", url: "/conversations", headers: { authorization: `bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("malformed JSON → 400 invalid_request, without internal details", async () => {
    const { app } = await createContext();
    const res = await app.inject({
      method: "POST", url: "/pairing", headers: { "content-type": "application/json" }, payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  test("body too large → 413 invalid_request", async () => {
    const { app } = await createContext();
    const res = await app.inject({
      method: "POST", url: "/pairing", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code: "123456", deviceName: "x".repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  test("exception in a route → 500 internal, without leaking the message", async () => {
    const ctx = await createContext();
    const token = await pair(ctx, "kevin");
    vi.spyOn(ctx.repository, "list").mockImplementation(() => {
      throw new Error("secret database detail");
    });
    const res = await ctx.app.inject({
      method: "GET", url: "/conversations", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });
});
