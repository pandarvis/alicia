import { describe, expect, test } from "vitest";
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
  const memory = createTestMemory(db, time.clock);
  const engine = new FakeEngine(() => [{ type: "done", inputTokens: 0, outputTokens: 0 }]);
  const app = await createServer({
    pairing, repository, version: "0.1.0", chat: {
      repository, engine, memory, clock: time.clock, timezone: "Europe/Paris",
    },
  });
  return { app, pairing, memory };
}

async function pair(ctx: Awaited<ReturnType<typeof createContext>>, person: string) {
  const code = ctx.pairing.generateCode(person);
  const res = await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code, deviceName: "PC" } });
  return res.json<{ token: string }>().token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const LASAGNES = { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" };
const UNKNOWN_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

describe("memories HTTP API", () => {
  test("401 without a valid token, on every route", async () => {
    const { app } = await createContext();
    for (const [method, url] of [
      ["GET", "/memories"],
      ["POST", "/memories"],
      ["PATCH", `/memories/${UNKNOWN_ID}`],
      ["DELETE", `/memories/${UNKNOWN_ID}`],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: auth("nope") })).statusCode).toBe(401);
    }
  });

  test("create, list, search, patch, delete — scoped to the caller", async () => {
    const ctx = await createContext();
    const kevin = await pair(ctx, "kevin");
    const elodie = await pair(ctx, "elodie");

    const created = await ctx.app.inject({ method: "POST", url: "/memories", headers: auth(kevin), payload: LASAGNES });
    expect(created.statusCode).toBe(201);
    const memory = created.json<{ id: string; scope: string; createdAt: string }>();
    expect(memory.scope).toBe("personal");
    expect(new Date(memory.createdAt).toISOString()).toBe(memory.createdAt);

    expect((await ctx.app.inject({ method: "GET", url: "/memories", headers: auth(kevin) })).json<unknown[]>()).toHaveLength(1);
    expect((await ctx.app.inject({ method: "GET", url: "/memories", headers: auth(elodie) })).json<unknown[]>()).toHaveLength(0);
    expect((await ctx.app.inject({ method: "GET", url: "/memories?q=lasagnes", headers: auth(kevin) })).json<unknown[]>()).toHaveLength(1);
    expect((await ctx.app.inject({ method: "GET", url: "/memories?q=lasagnes", headers: auth(elodie) })).json<unknown[]>()).toHaveLength(0);

    expect((await ctx.app.inject({ method: "PATCH", url: `/memories/${memory.id}`, headers: auth(elodie), payload: { pinned: true } })).statusCode).toBe(404);
    const patched = await ctx.app.inject({ method: "PATCH", url: `/memories/${memory.id}`, headers: auth(kevin), payload: { pinned: true } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ pinned: boolean }>().pinned).toBe(true);

    expect((await ctx.app.inject({ method: "DELETE", url: `/memories/${memory.id}`, headers: auth(elodie) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/memories/${memory.id}`, headers: auth(kevin) })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/memories", headers: auth(kevin) })).json<unknown[]>()).toHaveLength(0);
    expect((await ctx.app.inject({ method: "DELETE", url: `/memories/${memory.id}`, headers: auth(kevin) })).statusCode).toBe(404);
  });

  test("common memories are seen by everyone and filtered by scope and kind", async () => {
    const ctx = await createContext();
    const kevin = await pair(ctx, "kevin");
    const elodie = await pair(ctx, "elodie");
    await ctx.app.inject({
      method: "POST", url: "/memories", headers: auth(kevin),
      payload: { text: "On range les clés dans le panier", kind: "rule", scope: "common" },
    });
    await ctx.app.inject({ method: "POST", url: "/memories", headers: auth(kevin), payload: LASAGNES });

    const list = async (token: string, query: string) =>
      (await ctx.app.inject({ method: "GET", url: `/memories${query}`, headers: auth(token) })).json<{ scope: string }[]>();
    expect((await list(elodie, "")).map((m) => m.scope)).toEqual(["common"]);
    expect(await list(kevin, "")).toHaveLength(2);
    expect((await list(kevin, "?scope=personal")).map((m) => m.scope)).toEqual(["personal"]);
    expect((await list(kevin, "?scope=common")).map((m) => m.scope)).toEqual(["common"]);
    expect(await list(kevin, "?kind=rule")).toHaveLength(1);
    expect(await list(kevin, "?kind=event")).toHaveLength(0);
  });

  test("invalid query → 400", async () => {
    const ctx = await createContext();
    const headers = auth(await pair(ctx, "kevin"));
    for (const query of ["?scope=everyone", "?kind=nope", "?q="]) {
      expect((await ctx.app.inject({ method: "GET", url: `/memories${query}`, headers })).statusCode).toBe(400);
    }
  });

  test("browsing with ?q= does not count as a recall", async () => {
    const ctx = await createContext();
    const headers = auth(await pair(ctx, "kevin"));
    await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: LASAGNES });
    const found = await ctx.app.inject({ method: "GET", url: "/memories?q=lasagnes", headers });
    expect(found.json<{ recallCount: number }[]>().map((m) => m.recallCount)).toEqual([0]);
    const [stored] = ctx.memory.list("kevin", {});
    expect(stored?.recallCount).toBe(0);
    expect(stored?.lastRecalledAt).toBeNull();
  });

  test("duplicate → 409, secret → 422, empty or invalid body → 400", async () => {
    const ctx = await createContext();
    const headers = auth(await pair(ctx, "kevin"));
    await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: LASAGNES });

    const duplicate = await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: LASAGNES });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "duplicate" });

    const secret = await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: { ...LASAGNES, text: "mot de passe : x" } });
    expect(secret.statusCode).toBe(422);
    expect(secret.json()).toEqual({ error: "refused", reason: "secret" });

    const post = (payload: object) => ctx.app.inject({ method: "POST", url: "/memories", headers, payload });
    expect((await post({ text: "x" })).statusCode).toBe(400);
    expect((await post({ ...LASAGNES, text: "   " })).statusCode).toBe(400);
    expect((await post({ ...LASAGNES, extra: 1 })).statusCode).toBe(400);
  });

  test("patch: secret → 422, invalid body → 400, unknown id → 404", async () => {
    const ctx = await createContext();
    const headers = auth(await pair(ctx, "kevin"));
    const created = await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: LASAGNES });
    const { id } = created.json<{ id: string }>();
    const patch = (target: string, payload: object) =>
      ctx.app.inject({ method: "PATCH", url: `/memories/${target}`, headers, payload });

    const secret = await patch(id, { text: "le code pin : 1234" });
    expect(secret.statusCode).toBe(422);
    expect(secret.json()).toEqual({ error: "refused", reason: "secret" });
    expect((await patch(id, { text: "   " })).statusCode).toBe(400);
    expect((await patch(id, { bogus: true })).statusCode).toBe(400);
    const unknown = await patch(UNKNOWN_ID, { pinned: true });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "not_found" });

    const moved = await patch(id, { scope: "common", text: "La famille adore les lasagnes" });
    expect(moved.json<{ scope: string; text: string }>()).toMatchObject({ scope: "common", text: "La famille adore les lasagnes" });
  });
});
