import { HttpErrorBody } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import { ConversationLocks } from "../src/server/conversation-locks.ts";
import { errorBody } from "../src/server/http-errors.ts";
import { createServer, isAllowedOrigin } from "../src/server/server.ts";
import { createTestClock, createTestDb, createTestMemory } from "./helpers.ts";

async function createContext(options: { allowedOrigins?: readonly string[] } = {}) {
  const db = createTestDb();
  const time = createTestClock();
  const repository = new ConversationRepository(db, time.clock);
  const pairing = new PairingService(db, time.clock);
  const engine = new FakeEngine(() => [{ type: "done", inputTokens: 0, outputTokens: 0 }]);
  const locks = new ConversationLocks();
  const app = await createServer({
    locks, pairing, repository, version: "0.1.0", chat: {
      repository, engine, memory: createTestMemory(db, time.clock), clock: time.clock, timezone: "Europe/Paris",
    },
    ...(options.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  return { app, pairing, repository, locks, time };
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
    expect(res.json()).toEqual(errorBody("invalid_request"));
  });

  test("body too large → 413 invalid_request", async () => {
    const { app } = await createContext();
    const res = await app.inject({
      method: "POST", url: "/pairing", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code: "123456", deviceName: "x".repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual(errorBody("invalid_request"));
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
    expect(res.json()).toEqual(errorBody("internal"));
  });

  test("DELETE /conversations/:id → 204, then 404; 404 for another person; 401 without token", async () => {
    const ctx = await createContext();
    const mine = ctx.repository.create("kevin", "À moi");
    const hers = ctx.repository.create("elodie", "À elle");
    ctx.repository.addMessage(mine.id, "user", "Bonjour");
    const token = await pair(ctx, "kevin");
    const headers = { authorization: `Bearer ${token}` };

    expect((await ctx.app.inject({ method: "DELETE", url: `/conversations/${mine.id}` })).statusCode).toBe(401);
    expect(ctx.repository.get(mine.id, "kevin")).toBeDefined();

    const other = await ctx.app.inject({ method: "DELETE", url: `/conversations/${hers.id}`, headers });
    expect(other.statusCode).toBe(404);
    expect(ctx.repository.get(hers.id, "elodie")).toBeDefined();

    const done = await ctx.app.inject({ method: "DELETE", url: `/conversations/${mine.id}`, headers });
    expect(done.statusCode).toBe(204);
    expect(done.body).toBe("");
    expect(ctx.repository.get(mine.id, "kevin")).toBeUndefined();
    expect((await ctx.app.inject({ method: "DELETE", url: `/conversations/${mine.id}`, headers })).statusCode).toBe(404);
    // The lock is released: nothing stays blocked after a deletion.
    expect(ctx.locks.acquire("kevin", mine.id)).toBe(true);
  });

  test("DELETE /conversations/:id → 409 while a turn runs", async () => {
    const ctx = await createContext();
    const c = ctx.repository.create("kevin", "En cours");
    const token = await pair(ctx, "kevin");
    const headers = { authorization: `Bearer ${token}` };
    expect(ctx.locks.acquire("kevin", c.id)).toBe(true);

    const busy = await ctx.app.inject({ method: "DELETE", url: `/conversations/${c.id}`, headers });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual(errorBody("busy"));
    expect(ctx.repository.get(c.id, "kevin")).toBeDefined();

    ctx.locks.release("kevin", c.id);
    expect((await ctx.app.inject({ method: "DELETE", url: `/conversations/${c.id}`, headers })).statusCode).toBe(204);
  });

  test("every error answer follows the shared schema, unknown routes included", async () => {
    const ctx = await createContext();
    const token = await pair(ctx, "kevin");
    const busy = ctx.repository.create("kevin", "Occupée");
    expect(ctx.locks.acquire("kevin", busy.id)).toBe(true);
    const answers = [
      await ctx.app.inject({ method: "GET", url: "/conversations" }),
      await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code: "abc" } }),
      await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code: "000000", deviceName: "PC" } }),
      await ctx.app.inject({ method: "GET", url: "/nowhere" }),
      await ctx.app.inject({
        method: "DELETE", url: `/conversations/${busy.id}`, headers: { authorization: `Bearer ${token}` },
      }),
    ];
    expect(answers.map((a) => [a.statusCode, HttpErrorBody.parse(a.json()).error.code])).toEqual([
      [401, "unauthenticated"],
      [400, "invalid_request"],
      [401, "invalid_code"],
      [404, "not_found"],
      [409, "busy"],
    ]);
    for (const a of answers) expect(HttpErrorBody.parse(a.json()).error.message).not.toBe("");
  });

  test("errors raised by Fastify's router keep the typed shape", async () => {
    const { app } = await createContext();
    const badUrl = await app.inject({ method: "GET", url: "/memories/%E0%A4%A" });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json()).toEqual(errorBody("invalid_request"));
    const longParam = await app.inject({ method: "GET", url: `/conversations/${"x".repeat(200)}/messages` });
    expect(longParam.statusCode).toBe(414);
    expect(longParam.json()).toEqual(errorBody("invalid_request"));
  });

  test("a plain GET on /ws (no upgrade) gets the typed 404", async () => {
    const { app } = await createContext();
    const res = await app.inject({ method: "GET", url: "/ws" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(errorBody("not_found"));
  });

  test("POST /pairing: an address that keeps failing is blocked, the others are not", async () => {
    const ctx = await createContext();
    const attempt = (remoteAddress: string, code = "000000") =>
      ctx.app.inject({ method: "POST", url: "/pairing", remoteAddress, payload: { code, deviceName: "PC" } });

    for (let i = 0; i < 5; i++) expect((await attempt("10.0.0.1")).statusCode).toBe(401);
    // Even a valid code is refused from this address now.
    const blocked = await attempt("10.0.0.1", ctx.pairing.generateCode("kevin"));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual(errorBody("too_many_attempts"));

    // Past the global one-minute limit, another address pairs normally; the first one is still blocked.
    ctx.time.advance(61_000);
    expect((await attempt("10.0.0.2", ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
    expect((await attempt("10.0.0.1", ctx.pairing.generateCode("kevin"))).statusCode).toBe(429);

    // After 15 minutes, the first address may try again.
    ctx.time.advance(15 * 60_000);
    expect((await attempt("10.0.0.1", ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
  });

  test("POST /pairing: a successful pairing clears the address's failures", async () => {
    const ctx = await createContext();
    const attempt = (code = "000000") =>
      ctx.app.inject({ method: "POST", url: "/pairing", remoteAddress: "10.0.0.1", payload: { code, deviceName: "PC" } });
    for (let i = 0; i < 4; i++) expect((await attempt()).statusCode).toBe(401);
    ctx.time.advance(61_000); // past the global one-minute limit
    expect((await attempt(ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
    ctx.time.advance(61_000);
    for (let i = 0; i < 4; i++) expect((await attempt()).statusCode).toBe(401);
    // 8 failures within 15 minutes, but only 4 since the success.
    expect((await attempt(ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
  });

  test("POST /pairing: IPv6 addresses of the same /64 share their limit", async () => {
    const ctx = await createContext();
    const attempt = (remoteAddress: string, code = "000000") =>
      ctx.app.inject({ method: "POST", url: "/pairing", remoteAddress, payload: { code, deviceName: "PC" } });
    for (let i = 0; i < 5; i++) expect((await attempt(`2001:db8::${i + 1}`)).statusCode).toBe(401);
    ctx.time.advance(61_000);
    expect((await attempt("2001:db8::99", ctx.pairing.generateCode("kevin"))).statusCode).toBe(429);
    expect((await attempt("2001:db8:0:1::1", ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
  });
});

describe("CORS: only the Alicia app may call the brain from a browser page", () => {
  const preflight = (origin: string) => ({
    method: "OPTIONS" as const,
    url: "/pairing",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });

  test.each(["http://localhost:5173", "http://127.0.0.1:5173", "null", "file://"])("allowed origin %s", async (origin) => {
    const { app } = await createContext();
    const response = await app.inject(preflight(origin));
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
  });

  test.each(["https://evil.example", "http://localhost.evil.example", "http://192.168.1.50:5173"])(
    "refused origin %s: 403, no CORS header",
    async (origin) => {
      const { app } = await createContext();
      const response = await app.inject(preflight(origin));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(errorBody("forbidden_origin"));
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    },
  );

  test("a configured origin (future PWA) is allowed, exactly", async () => {
    const { app } = await createContext({ allowedOrigins: ["https://alicia.tailnet.ts.net"] });
    const ok = await app.inject(preflight("https://alicia.tailnet.ts.net"));
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://alicia.tailnet.ts.net");
    expect((await app.inject(preflight("https://alicia.tailnet.ts.net.evil.example"))).statusCode).toBe(403);
  });

  test("a foreign page cannot even read the health check", async () => {
    const { app } = await createContext();
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(errorBody("forbidden_origin"));
  });

  test("requests without Origin (CLI, curl) still work", async () => {
    const { app } = await createContext();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("isAllowedOrigin", () => {
  const extra = new Set(["https://alicia.tailnet.ts.net"]);
  test.each([undefined, "null", "file://", "http://localhost:5173", "http://127.0.0.1:4173", "https://alicia.tailnet.ts.net"])(
    "allows %s",
    (origin) => {
      expect(isAllowedOrigin(origin, extra)).toBe(true);
    },
  );
  test.each(["https://evil.example", "https://alicia.tailnet.ts.net.evil.example", "http://alicia.tailnet.ts.net", "http://192.168.1.50:5173"])(
    "refuses %s",
    (origin) => {
      expect(isAllowedOrigin(origin, extra)).toBe(false);
    },
  );
});
