import type { AddressInfo } from "node:net";
import { ServerEvent } from "@alicia/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { Engine, EngineEvent } from "../src/engine/engine.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import type { DrainOptions } from "../src/server/backpressure.ts";
import { createServer } from "../src/server/server.ts";
import { createChatDeps, createTestClock, createTestDb } from "./helpers.ts";

const REQUEST_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const REQUEST_ID_2 = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";
const REQUEST_ID_3 = "c9d8e7f6-5a4b-4c3d-9e2f-0a1b2c3d4e5f";
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface StartOptions {
  engine?: Engine;
  authTimeoutMs?: number;
  allowedOrigins?: readonly string[];
  heartbeatMs?: number;
  drain?: DrainOptions;
}

async function start(options: StartOptions = {}) {
  const db = createTestDb();
  const time = createTestClock();
  const pairing = new PairingService(db, time.clock);
  const fakeEngine = new FakeEngine(() => [
    { type: "session", sessionId: "s1" },
    { type: "text", text: "Coucou !" },
    { type: "done", inputTokens: 3, outputTokens: 2 },
  ]);
  const engine = options.engine ?? fakeEngine;
  const chat = createChatDeps(db, time.clock, engine);
  const { repository, memory } = chat;
  app = await createServer({
    pairing,
    repository,
    version: "0.1.0",
    chat,
    ...(options.authTimeoutMs === undefined
      ? {}
      : { authTimeoutMs: options.authTimeoutMs }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.drain === undefined ? {} : { drain: options.drain }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const r = pairing.redeem(pairing.generateCode("kevin"), "PC");
  if ("error" in r) throw new Error(r.error);
  const elodie = pairing.redeem(pairing.generateCode("elodie"), "Tablette");
  if ("error" in elodie) throw new Error(elodie.error);
  return {
    url: `ws://127.0.0.1:${port}/ws`, token: r.token, elodieToken: elodie.token, pairing, repository, memory, fakeEngine,
  };
}

/** Opens a connection and accumulates the received events (validated by the protocol). */
function connect(url: string) {
  const ws = new WebSocket(url);
  const received: ServerEvent[] = [];
  const waiters: { condition: (e: ServerEvent) => boolean; resolve: () => void }[] = [];
  ws.on("message", (data: WebSocket.RawData) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : "";
    received.push(ServerEvent.parse(JSON.parse(text)));
    for (const w of waiters.filter((x) => received.some(x.condition))) w.resolve();
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => { resolve(); }));
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => { resolve(code); }));
  const waitFor = (condition: (e: ServerEvent) => boolean) =>
    new Promise<void>((resolve) => {
      if (received.some(condition)) resolve();
      else waiters.push({ condition, resolve });
    });
  return { ws, received, opened, closed, waitFor };
}

/** Opens a socket with an Origin header: "open" when accepted, otherwise the HTTP status of the refused upgrade. */
function tryOrigin(url: string, origin: string): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once("open", () => {
      resolve("open");
      ws.close();
    });
    ws.once("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
    // A failure before any HTTP answer (refused connection…) settles at once instead of timing out.
    ws.on("error", (error) => {
      reject(error);
    });
  });
}

describe("WebSocket", () => {
  test("a foreign Origin is refused before the upgrade; the app's and configured ones are accepted", async () => {
    const { url } = await start({ allowedOrigins: ["https://alicia.tailnet.ts.net"] });
    expect(await tryOrigin(url, "https://evil.example")).toBe(403);
    expect(await tryOrigin(url, "file://")).toBe("open");
    expect(await tryOrigin(url, "null")).toBe("open");
    expect(await tryOrigin(url, "https://alicia.tailnet.ts.net")).toBe("open");
  });

  test("heartbeat: a live app gets heartbeat events and stays connected", async () => {
    const { url, token } = await start({ heartbeatMs: 100 });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    // Generous on purpose: a loaded machine may delay timers.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(c.received.filter((e) => e.type === "heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  test("heartbeat: a client that stops answering pings is dropped", async () => {
    const { url, token } = await start({ heartbeatMs: 100 });
    const ws = new WebSocket(url, { autoPong: false });
    ws.on("error", () => undefined);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => { resolve(code); }));
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "authenticate", token }));
    });
    expect(await closed).toBe(1006);
  });

  test("heartbeat: a device revoked while idle is disconnected with 4401", async () => {
    const { url, token, pairing } = await start({ heartbeatMs: 100 });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    const pc = pairing.listDevices().find((d) => d.personId === "kevin");
    expect(pairing.revokeDevice(pc?.id ?? "")).toBe(true);
    expect(await c.closed).toBe(4401);
    expect(c.received.at(-1)).toEqual({ type: "error", code: "unauthenticated", message: "Appareil révoqué." });
  });

  test("backpressure: no wait after the turn's final event, the turn slot is free at once", async () => {
    // Congested only once the engine has finished: waiting after "done" would hold the turn for a long time.
    const drain: DrainOptions = {
      highWaterBytes: Number.POSITIVE_INFINITY, timeoutMs: 60_000, pollMs: 5,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const engine: Engine = {
      async *run() {
        yield await Promise.resolve({ type: "session", sessionId: "s1" } as const);
        drain.highWaterBytes = -1;
        yield { type: "done", inputTokens: 1, outputTokens: 1 } as const;
      },
    };
    const { url, token } = await start({ engine, drain });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Un" }));
    await c.waitFor((e) => e.type === "done");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_2, text: "Deux" }));
    await c.waitFor((e) => e.type === "conversation" && e.requestId === REQUEST_ID_2);
    expect(c.received.some((e) => e.type === "error" && e.code === "busy")).toBe(false);
    c.ws.close();
  });

  test("backpressure on an existing conversation: its lock is released for the next connection", async () => {
    const { url, token, repository } = await start({
      drain: { highWaterBytes: -1, timeoutMs: 0, pollMs: 1, wait: () => Promise.resolve() },
    });
    const conversationId = repository.create("kevin", "Existante").id;
    const first = connect(url);
    await first.opened;
    first.ws.send(JSON.stringify({ type: "authenticate", token }));
    await first.waitFor((e) => e.type === "ready");
    first.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Un", conversationId }));
    expect(await first.closed).toBe(1013);

    const second = connect(url);
    await second.opened;
    second.ws.send(JSON.stringify({ type: "authenticate", token }));
    await second.waitFor((e) => e.type === "ready");
    second.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_2, text: "Deux", conversationId }));
    await second.waitFor((e) => e.type === "conversation" || e.type === "error");
    expect(second.received[1]).toEqual({ type: "conversation", requestId: REQUEST_ID_2, conversationId });
  });

  test("an app that does not drain its buffer: the turn stops and the connection closes with 1013", async () => {
    // A negative high-water mark makes every send look congested; a zero timeout gives up at once.
    const { url, token, repository } = await start({
      drain: { highWaterBytes: -1, timeoutMs: 0, pollMs: 1, wait: () => Promise.resolve() },
    });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    expect(await c.closed).toBe(1013);
    expect(c.received.some((e) => e.type === "done")).toBe(false);
    // Stopped at its very first event, the new conversation was still empty: it is not left in the list.
    expect(repository.list("kevin")).toEqual([]);
  });

  test("authentication then a full conversation", async () => {
    const { url, token } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    await c.waitFor((e) => e.type === "done");
    expect(c.received.map((e) => e.type)).toEqual(["ready", "conversation", "text_delta", "done"]);
    expect(c.received[0]).toEqual({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    c.ws.close();
  });

  test("wrong token: error then close 4401", async () => {
    const { url } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token: "x".repeat(43) }));
    expect(await c.closed).toBe(4401);
    expect(c.received).toEqual([{ type: "error", code: "unauthenticated", message: "Jeton refusé." }]);
  });

  test("send before authentication: rejected", async () => {
    const { url } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    expect(await c.closed).toBe(4401);
    expect(c.received).toEqual([{ type: "error", code: "unauthenticated", message: "Authentification attendue." }]);
  });

  test("unreadable message before authentication: rejected and close 4401", async () => {
    const { url } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send("not json");
    expect(await c.closed).toBe(4401);
    expect(c.received).toEqual([{ type: "error", code: "unauthenticated", message: "Authentification attendue." }]);
  });

  test("malformed message: invalid_request, the connection stays open", async () => {
    const { url, token } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send("not json");
    await c.waitFor((e) => e.type === "error");
    expect(c.received.at(-1)).toMatchObject({ code: "invalid_request" });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  test("no authentication within the timeout: error then close 4401", async () => {
    const { url } = await start({ authTimeoutMs: 50 });
    const c = connect(url);
    await c.opened;
    expect(await c.closed).toBe(4401);
    expect(c.received).toEqual([
      { type: "error", code: "unauthenticated", message: "Authentification attendue." },
    ]);
  });

  test("closing the connection mid-turn cancels the turn", async () => {
    let turnSignal: AbortSignal | undefined;
    let markTurnStarted: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const engine: Engine = {
      run(_request, signal): AsyncIterable<EngineEvent> {
        turnSignal = signal;
        return (async function* () {
          yield { type: "text", text: "Je réfléchis" } satisfies EngineEvent;
          markTurnStarted();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => { resolve(); }, { once: true });
          });
        })();
      },
    };
    const { url, token } = await start({ engine });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    await turnStarted;
    expect(turnSignal?.aborted).toBe(false);

    const aborted = new Promise<void>((resolve) => {
      turnSignal?.addEventListener("abort", () => { resolve(); }, { once: true });
    });
    c.ws.close();
    await aborted;
    expect(turnSignal?.aborted).toBe(true);
  });
  test("the identity is fixed: a second authenticate is rejected", async () => {
    const { url, token, elodieToken, fakeEngine } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "authenticate", token: elodieToken }));
    await c.waitFor((e) => e.type === "error");
    expect(c.received.at(-1)).toEqual({ type: "error", code: "invalid_request", message: "Déjà authentifié." });
    expect(c.received.filter((e) => e.type === "ready")).toHaveLength(1);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);

    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    await c.waitFor((e) => e.type === "done");
    expect(fakeEngine.requests[0]?.systemPrompt).toContain("Tu parles avec Kévin.");
    c.ws.close();
  });

  test("a single turn at a time per connection", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: Engine = {
      run(): AsyncIterable<EngineEvent> {
        calls += 1;
        const n = calls;
        return (async function* () {
          yield { type: "text", text: "…" } satisfies EngineEvent;
          if (n === 1) {
            markStarted();
            await released;
          }
          yield { type: "done", inputTokens: 1, outputTokens: 1 } satisfies EngineEvent;
        })();
      },
    };
    const { url, token } = await start({ engine });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Un" }));
    await firstStarted;

    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_2, text: "Deux" }));
    await c.waitFor((e) => e.type === "error");
    expect(c.received.at(-1)).toEqual({
      type: "error",
      requestId: REQUEST_ID_2,
      code: "busy",
      message: "Alicia répond déjà ; réessaie après sa réponse.",
    });
    expect(calls).toBe(1);

    release();
    await c.waitFor((e) => e.type === "done");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_3, text: "Trois" }));
    await c.waitFor((e) => e.type === "conversation" && e.requestId === REQUEST_ID_3);
    expect(calls).toBe(2);
    c.ws.close();
  });

  test("device revoked during the connection: the next send is rejected and the connection closed with 4401", async () => {
    const { url, token, pairing, fakeEngine } = await start();
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");

    const pc = pairing.listDevices().find((d) => d.personId === "kevin");
    expect(pairing.revokeDevice(pc?.id ?? "")).toBe(true);

    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    expect(await c.closed).toBe(4401);
    expect(c.received.slice(1)).toEqual([{ type: "error", code: "unauthenticated", message: "Appareil révoqué." }]);
    expect(fakeEngine.requests).toHaveLength(0);
  });

  test("a single turn at a time per conversation, across all devices", async () => {
    // 1st call: fast (creates conversation C); 2nd and 3rd calls: blocked until released.
    let calls = 0;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => undefined;
    const blockedTurnStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: Engine = {
      run(): AsyncIterable<EngineEvent> {
        calls += 1;
        const n = calls;
        return (async function* () {
          yield { type: "text", text: "…" } satisfies EngineEvent;
          if (n === 2) markStarted();
          if (n === 2 || n === 3) await released;
          yield { type: "done", inputTokens: 1, outputTokens: 1 } satisfies EngineEvent;
        })();
      },
    };
    const { url, token, pairing } = await start({ engine });
    const second = pairing.redeem(pairing.generateCode("kevin"), "Téléphone Kévin");
    if ("error" in second) throw new Error(second.error);

    const a = connect(url);
    const b = connect(url);
    await Promise.all([a.opened, b.opened]);
    a.ws.send(JSON.stringify({ type: "authenticate", token }));
    b.ws.send(JSON.stringify({ type: "authenticate", token: second.token }));
    await Promise.all([a.waitFor((e) => e.type === "ready"), b.waitFor((e) => e.type === "ready")]);

    a.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Un" }));
    await a.waitFor((e) => e.type === "done");
    const conversation = a.received.find((e) => e.type === "conversation");
    const conversationId = conversation?.type === "conversation" ? conversation.conversationId : "";

    a.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_2, text: "Deux", conversationId }));
    await blockedTurnStarted;

    b.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_3, text: "Trois", conversationId }));
    await b.waitFor((e) => e.type === "error");
    expect(b.received.at(-1)).toEqual({
      type: "error",
      requestId: REQUEST_ID_3,
      code: "busy",
      message: "Alicia répond déjà dans cette conversation.",
    });
    expect(calls).toBe(2);

    // A new conversation is never blocked.
    const NEW_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    b.ws.send(JSON.stringify({ type: "send", requestId: NEW_ID, text: "Ailleurs" }));
    await b.waitFor((e) => e.type === "conversation" && e.requestId === NEW_ID);
    expect(calls).toBe(3);

    release();
    await a.waitFor((e) => e.type === "done" && a.received.filter((x) => x.type === "done").length === 2);
    await b.waitFor((e) => e.type === "done");

    const AFTER_ID = "1c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e";
    b.ws.send(JSON.stringify({ type: "send", requestId: AFTER_ID, text: "Quatre", conversationId }));
    await b.waitFor((e) => e.type === "conversation" && e.requestId === AFTER_ID);
    expect(b.received.find((e) => e.type === "conversation" && e.requestId === AFTER_ID)).toEqual({
      type: "conversation", requestId: AFTER_ID, conversationId,
    });
    await b.waitFor((e) => e.type === "done" && b.received.filter((x) => x.type === "done").length === 2);
    expect(calls).toBe(4);
    a.ws.close();
    b.ws.close();
  });

  test("a just-created conversation is locked as soon as its id is known", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const engine: Engine = {
      run(): AsyncIterable<EngineEvent> {
        calls += 1;
        return (async function* () {
          yield { type: "text", text: "…" } satisfies EngineEvent;
          await released;
          yield { type: "done", inputTokens: 1, outputTokens: 1 } satisfies EngineEvent;
        })();
      },
    };
    const { url, token, pairing } = await start({ engine });
    const second = pairing.redeem(pairing.generateCode("kevin"), "Téléphone Kévin");
    if ("error" in second) throw new Error(second.error);
    const a = connect(url);
    const b = connect(url);
    await Promise.all([a.opened, b.opened]);
    a.ws.send(JSON.stringify({ type: "authenticate", token }));
    b.ws.send(JSON.stringify({ type: "authenticate", token: second.token }));
    await Promise.all([a.waitFor((e) => e.type === "ready"), b.waitFor((e) => e.type === "ready")]);

    a.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Un" }));
    await a.waitFor((e) => e.type === "text_delta");
    const conversation = a.received.find((e) => e.type === "conversation");
    const conversationId = conversation?.type === "conversation" ? conversation.conversationId : "";

    b.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_2, text: "Deux", conversationId }));
    await b.waitFor((e) => e.type === "error");
    expect(b.received.at(-1)).toMatchObject({ requestId: REQUEST_ID_2, code: "busy" });
    expect(calls).toBe(1);

    release();
    await a.waitFor((e) => e.type === "done");
    a.ws.close();
    b.ws.close();
  });

  test("another person's conversation is not found and stays intact", async () => {
    const { url, token, elodieToken, repository, fakeEngine } = await start();
    const k = connect(url);
    await k.opened;
    k.ws.send(JSON.stringify({ type: "authenticate", token }));
    await k.waitFor((e) => e.type === "ready");
    k.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Secret de Kévin" }));
    await k.waitFor((e) => e.type === "done");
    const conversation = k.received.find((e) => e.type === "conversation");
    const conversationId = conversation?.type === "conversation" ? conversation.conversationId : "";
    const before = repository.messages(conversationId);
    expect(before).toHaveLength(2);

    const e = connect(url);
    await e.opened;
    e.ws.send(JSON.stringify({ type: "authenticate", token: elodieToken }));
    await e.waitFor((x) => x.type === "ready");
    e.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID_2, text: "Je m'invite", conversationId }));
    await e.waitFor((x) => x.type === "error");
    expect(e.received.slice(1)).toEqual([
      { type: "error", requestId: REQUEST_ID_2, code: "invalid_request", message: "Conversation introuvable." },
    ]);
    expect(repository.messages(conversationId)).toEqual(before);
    expect(repository.list("elodie")).toHaveLength(0);
    expect(fakeEngine.requests).toHaveLength(1);
    expect(e.ws.readyState).toBe(WebSocket.OPEN);
    k.ws.close();
    e.ws.close();
  });

  test("a synchronous exception does not bring the process down: internal error and close 1011", async () => {
    const { url, token, pairing } = await start();
    vi.spyOn(pairing, "authenticateDevice").mockImplementation(() => {
      throw new Error("broken database");
    });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    expect(await c.closed).toBe(1011);
    expect(c.received).toEqual([{ type: "error", code: "internal", message: "Erreur interne." }]);
  });
});
