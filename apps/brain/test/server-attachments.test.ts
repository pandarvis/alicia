import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AttachmentSummary, HistoryMessage, HttpErrorBody } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import { createServer } from "../src/server/server.ts";
import { createChatDeps, createTestClock, createTestDb, PDF_BYTES, PNG_BYTES } from "./helpers.ts";

async function createContext() {
  const db = createTestDb();
  const time = createTestClock();
  const deps = createChatDeps(db, time.clock, new FakeEngine(() => [{ type: "done", inputTokens: 0, outputTokens: 0 }]));
  const pairing = new PairingService(db, time.clock);
  const app = await createServer({ pairing, repository: deps.repository, version: "0.1.0", chat: deps });
  const tokenOf = async (person: string) => {
    const res = await app.inject({ method: "POST", url: "/pairing", payload: { code: pairing.generateCode(person), deviceName: "PC" } });
    return res.json<{ token: string }>().token;
  };
  return { app, deps, time, kevin: await tokenOf("kevin"), elodie: await tokenOf("elodie") };
}

type Ctx = Awaited<ReturnType<typeof createContext>>;

function upload(ctx: Ctx, token: string | undefined, name: string | undefined, body: Uint8Array, contentType = "application/octet-stream") {
  return ctx.app.inject({
    method: "POST",
    url: "/attachments",
    headers: {
      "content-type": contentType,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(name !== undefined ? { "x-attachment-name": encodeURIComponent(name) } : {}),
    },
    payload: Buffer.from(body),
  });
}

async function uploaded(ctx: Ctx, token: string, name: string, body: Uint8Array = PDF_BYTES): Promise<AttachmentSummary> {
  const res = await upload(ctx, token, name, body);
  expect(res.statusCode).toBe(201);
  return AttachmentSummary.parse(res.json());
}

const codeOf = (body: unknown): string => HttpErrorBody.parse(body).error.code;

describe("POST /attachments", () => {
  test("401 without a valid token", async () => {
    const ctx = await createContext();
    expect((await upload(ctx, undefined, "a.pdf", PDF_BYTES)).statusCode).toBe(401);
    expect((await upload(ctx, "nope", "a.pdf", PDF_BYTES)).statusCode).toBe(401);
  });

  test("an unknown device is refused before its body is read: 401, not 413, for 26 MB", async () => {
    const ctx = await createContext();
    const res = await upload(ctx, undefined, "gros.pdf", new Uint8Array(26 * 1024 * 1024));
    expect(res.statusCode).toBe(401);
    expect(codeOf(res.json())).toBe("unauthenticated");
  });

  test("201 with the summary; the UTF-8 name survives", async () => {
    const ctx = await createContext();
    const summary = await uploaded(ctx, ctx.kevin, "Facture été.pdf");
    expect(summary).toMatchObject({ name: "Facture été.pdf", kind: "pdf", size: PDF_BYTES.byteLength });
    expect(ctx.deps.attachments.pending("kevin", [summary.id])).toHaveLength(1);
    // Nobody else's pending upload.
    expect(ctx.deps.attachments.pending("elodie", [summary.id])).toBeUndefined();
  });

  test("a name is never a path: only its last segment is kept, the file on disk is named by the brain", async () => {
    const ctx = await createContext();
    const summary = await uploaded(ctx, ctx.kevin, "..\\..\\..\\Windows\\evil.pdf");
    expect(summary.name).toBe("evil.pdf");
    const slash = await uploaded(ctx, ctx.kevin, "../../etc/passwd.txt", new TextEncoder().encode("root"));
    expect(slash.name).toBe("passwd.txt");
    const pendingDir = join(dirname(ctx.deps.attachments.dirOf("3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192")), "pending");
    expect(readdirSync(pendingDir).sort()).toEqual([`${summary.id}.pdf`, `${slash.id}.txt`].sort());
  });

  test("413 over 25 MB, 415 unsupported or disguised, 400 without a name or empty", async () => {
    const ctx = await createContext();
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(PDF_BYTES);
    const tooBig = await upload(ctx, ctx.kevin, "gros.pdf", big);
    expect(tooBig.statusCode).toBe(413);
    expect(codeOf(tooBig.json())).toBe("too_large");
    const exe = await upload(ctx, ctx.kevin, "virus.exe", PDF_BYTES);
    expect(exe.statusCode).toBe(415);
    expect(codeOf(exe.json())).toBe("unsupported");
    expect((await upload(ctx, ctx.kevin, "photo.pdf", PNG_BYTES)).statusCode).toBe(415);
    expect((await upload(ctx, ctx.kevin, undefined, PDF_BYTES)).statusCode).toBe(400);
    const empty = await upload(ctx, ctx.kevin, "vide.pdf", new Uint8Array(0));
    expect(empty.statusCode).toBe(400);
    expect(codeOf(empty.json())).toBe("empty");
  });

  test("a malformed name header (bad percent-encoding, too long) is a 400", async () => {
    const ctx = await createContext();
    const bad = await ctx.app.inject({
      method: "POST", url: "/attachments", payload: Buffer.from(PDF_BYTES),
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${ctx.kevin}`, "x-attachment-name": "%E0%A4%A.pdf" },
    });
    expect(bad.statusCode).toBe(400);
    expect((await upload(ctx, ctx.kevin, `${"a".repeat(5000)}.pdf`, PDF_BYTES)).statusCode).toBe(400);
    // A long but sane name is kept, cut to 200 characters.
    const long = await upload(ctx, ctx.kevin, `${"é".repeat(600)}.pdf`, PDF_BYTES);
    expect(long.statusCode).toBe(201);
    expect(AttachmentSummary.parse(long.json()).name).toHaveLength(200);
  });

  test("a missing name or a refused type is answered before the body is read (not 413 for 26 MB)", async () => {
    const ctx = await createContext();
    const big = new Uint8Array(26 * 1024 * 1024);
    const noName = await upload(ctx, ctx.kevin, undefined, big);
    expect(noName.statusCode).toBe(400);
    const exe = await upload(ctx, ctx.kevin, "virus.exe", big);
    expect(exe.statusCode).toBe(415);
    expect(codeOf(exe.json())).toBe("unsupported");
  });

  test("the app's preflight (Origin null, custom headers) is answered", async () => {
    const ctx = await createContext();
    const res = await ctx.app.inject({
      method: "OPTIONS", url: "/attachments",
      headers: {
        origin: "null", "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-attachment-name",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("null");
    expect(String(res.headers["access-control-allow-headers"])).toContain("x-attachment-name");
  });

  test("a failure while storing is the usual typed 500, without details", async () => {
    const ctx = await createContext();
    vi.spyOn(ctx.deps.attachments, "upload").mockImplementation(() => {
      throw new Error("disk detail");
    });
    const res = await upload(ctx, ctx.kevin, "a.pdf", PDF_BYTES);
    expect(res.statusCode).toBe(500);
    expect(codeOf(res.json())).toBe("internal");
    expect(res.body).not.toContain("disk detail");
  });

  test("only raw bytes are accepted (415 for another content type)", async () => {
    const ctx = await createContext();
    const json = await upload(ctx, ctx.kevin, "a.txt", new TextEncoder().encode("{\"a\":1}"), "application/json");
    expect(json.statusCode).toBe(415);
    expect(codeOf(json.json())).toBe("unsupported");
  });
});

describe("DELETE /attachments/:id", () => {
  test("the owner drops a pending upload; someone else gets 404 and the file stays", async () => {
    const ctx = await createContext();
    const { id } = await uploaded(ctx, ctx.kevin, "a.pdf");
    const del = (token: string) => ctx.app.inject({ method: "DELETE", url: `/attachments/${id}`, headers: { authorization: `Bearer ${token}` } });
    expect((await del(ctx.elodie)).statusCode).toBe(404);
    expect(ctx.deps.attachments.pending("kevin", [id])).toHaveLength(1);
    expect((await del(ctx.kevin)).statusCode).toBe(204);
    expect((await del(ctx.kevin)).statusCode).toBe(404);
    expect(ctx.deps.attachments.pending("kevin", [id])).toBeUndefined();
  });

  test("401 without a token; an attachment already sent in a message cannot be dropped", async () => {
    const ctx = await createContext();
    const { id } = await uploaded(ctx, ctx.kevin, "a.pdf");
    expect((await ctx.app.inject({ method: "DELETE", url: `/attachments/${id}` })).statusCode).toBe(401);
    const c = ctx.deps.repository.create("kevin", "Factures");
    const messageId = ctx.deps.repository.addMessage(c.id, "user", "Regarde");
    await ctx.deps.attachments.claim("kevin", [id], c.id, messageId);
    const res = await ctx.app.inject({ method: "DELETE", url: `/attachments/${id}`, headers: { authorization: `Bearer ${ctx.kevin}` } });
    expect(res.statusCode).toBe(404);
    expect(ctx.deps.attachments.pathOf("kevin", c.id, id)).toBeDefined();
  });
});

describe("history and deletion", () => {
  test("history lists each message's attachments; deleting the conversation removes the files", async () => {
    const ctx = await createContext();
    const { id } = await uploaded(ctx, ctx.kevin, "a.pdf");
    const c = ctx.deps.repository.create("kevin", "Factures");
    const messageId = ctx.deps.repository.addMessage(c.id, "user", "Regarde");
    ctx.deps.repository.addMessage(c.id, "assistant", "Vu.");
    await ctx.deps.attachments.claim("kevin", [id], c.id, messageId);
    const headers = { authorization: `Bearer ${ctx.kevin}` };
    const history = z.array(HistoryMessage).parse((await ctx.app.inject({ method: "GET", url: `/conversations/${c.id}/messages`, headers })).json());
    expect(history.map((m) => m.attachments.map((a) => a.name))).toEqual([["a.pdf"], []]);
    const dir = ctx.deps.attachments.dirOf(c.id);
    expect(existsSync(dir)).toBe(true);
    // Someone else can neither see nor delete them.
    const elodie = { authorization: `Bearer ${ctx.elodie}` };
    expect((await ctx.app.inject({ method: "GET", url: `/conversations/${c.id}/messages`, headers: elodie })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/conversations/${c.id}`, headers: elodie })).statusCode).toBe(404);
    expect(existsSync(dir)).toBe(true);
    expect((await ctx.app.inject({ method: "DELETE", url: `/conversations/${c.id}`, headers })).statusCode).toBe(204);
    expect(existsSync(dir)).toBe(false);
  });

  test("files that cannot be removed now do not fail the deletion (the startup sweep gets them)", async () => {
    const ctx = await createContext();
    const c = ctx.deps.repository.create("kevin", "Factures");
    vi.spyOn(ctx.deps.attachments, "removeConversationFiles").mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const res = await ctx.app.inject({ method: "DELETE", url: `/conversations/${c.id}`, headers: { authorization: `Bearer ${ctx.kevin}` } });
    expect(res.statusCode).toBe(204);
    expect(ctx.deps.repository.get(c.id, "kevin")).toBeUndefined();
  });
});
