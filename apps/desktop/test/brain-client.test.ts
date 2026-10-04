import { describe, expect, test } from "vitest";
import {
  BrainApi, normalizeServerUrl, pair, UnauthorizedError, webSocketUrl,
} from "../src/renderer/src/lib/brain-client.ts";

const CONVERSATION_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const MEMORY_ID = "7a2d9c4e-1b3f-4e5a-8c6d-0f1e2d3c4b5a";

const MEMORY = {
  id: MEMORY_ID,
  scope: "personal",
  kind: "fact",
  text: "Kévin boit du thé le matin",
  pinned: false,
  source: "manual",
  conversationId: null,
  conversationTitle: null,
  createdAt: "2026-10-04T13:30:00.000Z",
  updatedAt: "2026-10-04T13:30:00.000Z",
  recallCount: 0,
  lastRecalledAt: null,
  forgottenAt: null,
};

/** A typed error body, as the brain sends it. */
const brainError = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "Message du cerveau.", ...extra },
});

/** Records the last request and answers with a fixed response. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    // A 204 response cannot carry a body.
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
  };
  return { calls, fetchFn };
}

describe("server URL", () => {
  test("adds http:// and strips trailing slashes", () => {
    expect(normalizeServerUrl(" 192.168.1.20:8780/ ")).toBe("http://192.168.1.20:8780");
    expect(normalizeServerUrl("https://alicia.ts.net")).toBe("https://alicia.ts.net");
  });
  test("lowercases the scheme and strips query and fragment", () => {
    expect(normalizeServerUrl("HTTPS://alicia.ts.net/?a=1#frag")).toBe("https://alicia.ts.net");
    expect(normalizeServerUrl("https://host/alicia/?x=1")).toBe("https://host/alicia");
  });
  test("rejects invalid or non-http URLs", () => {
    expect(normalizeServerUrl("ftp://x")).toBeNull();
    expect(normalizeServerUrl("http://")).toBeNull();
    expect(normalizeServerUrl("")).toBeNull();
  });
  test("derives the WebSocket URL", () => {
    expect(webSocketUrl("http://127.0.0.1:8780")).toBe("ws://127.0.0.1:8780/ws");
    expect(webSocketUrl("https://alicia.ts.net")).toBe("wss://alicia.ts.net/ws");
    expect(webSocketUrl("https://host/alicia")).toBe("wss://host/alicia/ws");
  });
});

describe("pair", () => {
  test("success returns a full session", async () => {
    const { calls, fetchFn } = fakeFetch(200, { token: "t".repeat(43), person: { id: "kevin", name: "Kévin" } });
    const result = await pair(fetchFn, "127.0.0.1:8780", "123456", "PC-KEVIN");
    expect(result).toEqual({
      ok: true,
      session: { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43), person: { id: "kevin", name: "Kévin" } },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8780/pairing");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ code: "123456", deviceName: "PC-KEVIN" }));
  });
  test.each([
    [401, brainError("invalid_code"), "invalid_code"],
    [429, brainError("too_many_attempts"), "too_many_attempts"],
    [400, brainError("invalid_request"), "invalid_request"],
  ] as const)("HTTP %i → %s", async (status, body, reason) => {
    const { fetchFn } = fakeFetch(status, body);
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason });
  });
  test("invalid server URL → invalid_request, without any request", async () => {
    const { calls, fetchFn } = fakeFetch(200, {});
    expect(await pair(fetchFn, "ftp://x", "123456", "PC")).toEqual({ ok: false, reason: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
  test("5xx → unreachable", async () => {
    const { fetchFn } = fakeFetch(503, brainError("internal"));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
  });
  test("200 with a non-JSON body → unreachable (never throws)", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("<html>nope</html>", { status: 200 }));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
  });
  test("body read failure → unreachable (never throws)", async () => {
    const body = new ReadableStream({ start: (controller) => { controller.error(new TypeError("terminated")); } });
    const fetchFn: typeof fetch = () => Promise.resolve(new Response(body, { status: 200 }));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
  });
  test("timeout → unreachable, and a timeout signal is sent", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn: typeof fetch = (_input, init) => {
      signal = init?.signal;
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    };
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  test("network failure → unreachable", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
  });
  test("the typed code wins over the status", async () => {
    const { fetchFn } = fakeFetch(400, brainError("too_many_attempts"));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "too_many_attempts" });
  });
  test("an error body that is not typed falls back on the status", async () => {
    const { fetchFn } = fakeFetch(429, { nope: true });
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "too_many_attempts" });
  });
});

describe("BrainApi", () => {
  const session = { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43), person: { id: "kevin", name: "Kévin" } };

  test("lists conversations with the device token", async () => {
    const { calls, fetchFn } = fakeFetch(200, [
      { id: CONVERSATION_ID, title: "Volets", updatedAt: "2026-10-04T13:30:00.000Z" },
    ]);
    const list = await new BrainApi(fetchFn, session).listConversations();
    expect(list.map((c) => c.title)).toEqual(["Volets"]);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });
  test("history of a conversation", async () => {
    const { calls, fetchFn } = fakeFetch(200, [
      { id: CONVERSATION_ID, role: "user", text: "Salut", createdAt: "2026-10-04T13:30:00.000Z" },
    ]);
    const history = await new BrainApi(fetchFn, session).history(CONVERSATION_ID);
    expect(history[0]?.text).toBe("Salut");
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8780/conversations/${CONVERSATION_ID}/messages`);
  });
  test("401 → UnauthorizedError (revoked device)", async () => {
    const { fetchFn } = fakeFetch(401, brainError("unauthenticated"));
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  test("malformed answer is rejected", async () => {
    const { fetchFn } = fakeFetch(200, [{ nope: true }]);
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toThrow();
  });
  test("calls fetch unbound (native fetch throws 'Illegal invocation' otherwise)", async () => {
    const fetchFn = Object.assign(
      function (this: unknown): Promise<Response> {
        if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
        return Promise.resolve(new Response("[]", { status: 200 }));
      },
      { preconnect: () => undefined },
    );
    expect(await new BrainApi(fetchFn, session).listConversations()).toEqual([]);
  });
  test("a timeout signal is sent and a timeout rejects", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn: typeof fetch = (_input, init) => {
      signal = init?.signal;
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    };
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toThrow();
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  describe("memories", () => {
    const authorization = `Bearer ${"t".repeat(43)}`;
    type Call = { init: RequestInit | undefined } | undefined;
    const method = (call: Call) => call?.init?.method;
    const header = (call: Call, name: string) => new Headers(call?.init?.headers).get(name);
    const api = (status: number, body: unknown) => new BrainApi(fakeFetch(status, body).fetchFn, session);

    test("listMemories without a filter asks for the plain list", async () => {
      const { calls, fetchFn } = fakeFetch(200, [MEMORY]);
      const list = await new BrainApi(fetchFn, session).listMemories({});
      expect(list.map((m) => m.id)).toEqual([MEMORY_ID]);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8780/memories");
      expect(header(calls[0], "authorization")).toBe(authorization);
    });
    test("listMemories encodes every filter, including a q with spaces and accents", async () => {
      const { calls, fetchFn } = fakeFetch(200, []);
      await new BrainApi(fetchFn, session).listMemories({ scope: "common", kind: "habit", q: "thé du matin & café?" });
      const url = new URL(calls[0]?.url ?? "");
      expect(url.pathname).toBe("/memories");
      expect(url.searchParams.get("scope")).toBe("common");
      expect(url.searchParams.get("kind")).toBe("habit");
      expect(url.searchParams.get("q")).toBe("thé du matin & café?");
      expect(url.searchParams.has("forgotten")).toBe(false);
      expect(calls[0]?.url).not.toContain(" ");
    });
    test("listMemories asks for the trash only when forgotten is true", async () => {
      const trash = fakeFetch(200, []);
      await new BrainApi(trash.fetchFn, session).listMemories({ forgotten: true });
      expect(new URL(trash.calls[0]?.url ?? "").searchParams.get("forgotten")).toBe("true");
      const live = fakeFetch(200, []);
      await new BrainApi(live.fetchFn, session).listMemories({ forgotten: false });
      expect(live.calls[0]?.url).toBe("http://127.0.0.1:8780/memories");
    });
    test("listMemories rejects a malformed answer, a 401 and a 5xx", async () => {
      await expect(api(200, [{ nope: true }]).listMemories({})).rejects.toThrow();
      await expect(api(401, {}).listMemories({})).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(500, {}).listMemories({})).rejects.toThrow(/500/);
    });

    const input = { text: "Kévin boit du thé le matin", kind: "fact", scope: "personal" } as const;
    test("createMemory posts JSON and returns the created memory", async () => {
      const { calls, fetchFn } = fakeFetch(201, MEMORY);
      const result = await new BrainApi(fetchFn, session).createMemory(input);
      expect(result).toEqual({ ok: true, memory: MEMORY });
      expect(method(calls[0])).toBe("POST");
      expect(calls[0]?.url).toBe("http://127.0.0.1:8780/memories");
      expect(header(calls[0], "authorization")).toBe(authorization);
      expect(header(calls[0], "content-type")).toBe("application/json");
      expect(calls[0]?.init?.body).toBe(JSON.stringify(input));
      expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    });
    test.each([
      [409, brainError("duplicate"), "duplicate"],
      [422, brainError("refused", { reason: "secret" }), "secret"],
      [422, brainError("refused", { reason: "empty" }), "empty"],
      [400, brainError("invalid_request"), "invalid"],
    ] as const)("createMemory HTTP %i %j → %s", async (status, body, reason) => {
      expect(await api(status, body).createMemory(input)).toEqual({ ok: false, reason });
    });
    test("createMemory: 401 → UnauthorizedError, other statuses and odd bodies throw", async () => {
      await expect(api(401, {}).createMemory(input)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(500, {}).createMemory(input)).rejects.toThrow(/500/);
      await expect(api(422, brainError("refused", { reason: "weird" })).createMemory(input)).rejects.toThrow();
      await expect(api(201, { nope: true }).createMemory(input)).rejects.toThrow();
    });
    test("createMemory: an unexpected typed error throws with its status and code", async () => {
      await expect(api(409, brainError("busy")).createMemory(input)).rejects.toThrow(/409 \(busy\)/);
    });
    // Old flat shape on purpose (added after the replacement above): an untyped body is never guessed.
    test("createMemory: a 409 without a typed body throws instead of guessing", async () => {
      await expect(api(409, { error: "duplicate" }).createMemory(input)).rejects.toThrow(/409/);
    });

    test("updateMemory patches by id and returns the updated memory", async () => {
      const { calls, fetchFn } = fakeFetch(200, { ...MEMORY, pinned: true });
      const result = await new BrainApi(fetchFn, session).updateMemory(MEMORY_ID, { pinned: true });
      expect(result).toEqual({ ok: true, memory: { ...MEMORY, pinned: true } });
      expect(method(calls[0])).toBe("PATCH");
      expect(calls[0]?.url).toBe(`http://127.0.0.1:8780/memories/${MEMORY_ID}`);
      expect(header(calls[0], "content-type")).toBe("application/json");
      expect(calls[0]?.init?.body).toBe(JSON.stringify({ pinned: true }));
    });
    test.each([
      [404, brainError("not_found"), "not_found"],
      [422, brainError("refused", { reason: "secret" }), "secret"],
      [422, brainError("refused", { reason: "empty" }), "empty"],
      [409, brainError("duplicate"), "duplicate"],
      [400, brainError("invalid_request"), "invalid"],
    ] as const)("updateMemory HTTP %i %j → %s", async (status, body, reason) => {
      expect(await api(status, body).updateMemory(MEMORY_ID, { text: "x" })).toEqual({ ok: false, reason });
    });
    test("updateMemory: 401 → UnauthorizedError, 5xx throws", async () => {
      await expect(api(401, {}).updateMemory(MEMORY_ID, { pinned: true })).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(503, {}).updateMemory(MEMORY_ID, { pinned: true })).rejects.toThrow(/503/);
    });

    test("forgetMemory: 204 → true, 404 → false", async () => {
      const done = fakeFetch(204, null);
      expect(await new BrainApi(done.fetchFn, session).forgetMemory(MEMORY_ID)).toBe(true);
      expect(method(done.calls[0])).toBe("DELETE");
      expect(done.calls[0]?.url).toBe(`http://127.0.0.1:8780/memories/${MEMORY_ID}`);
      expect(header(done.calls[0], "authorization")).toBe(authorization);
      expect(await api(404, brainError("not_found")).forgetMemory(MEMORY_ID)).toBe(false);
    });
    test("forgetMemory: 401 → UnauthorizedError, 5xx throws", async () => {
      await expect(api(401, {}).forgetMemory(MEMORY_ID)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(500, {}).forgetMemory(MEMORY_ID)).rejects.toThrow(/500/);
    });

    test("restoreMemory: 200 → the memory, 404 → null", async () => {
      const done = fakeFetch(200, MEMORY);
      expect(await new BrainApi(done.fetchFn, session).restoreMemory(MEMORY_ID)).toEqual(MEMORY);
      expect(method(done.calls[0])).toBe("POST");
      expect(done.calls[0]?.url).toBe(`http://127.0.0.1:8780/memories/${MEMORY_ID}/restore`);
      expect(done.calls[0]?.init?.body).toBeUndefined();
      expect(await api(404, brainError("not_found")).restoreMemory(MEMORY_ID)).toBeNull();
    });
    test("restoreMemory: 401 → UnauthorizedError, 5xx and malformed answers throw", async () => {
      await expect(api(401, {}).restoreMemory(MEMORY_ID)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(500, {}).restoreMemory(MEMORY_ID)).rejects.toThrow(/500/);
      await expect(api(200, { nope: 1 }).restoreMemory(MEMORY_ID)).rejects.toThrow();
    });

    test("testMemory encodes the question and validates the hits", async () => {
      const hit = { memory: MEMORY, rank: 1, textMatch: true, similarity: 0.42 };
      const { calls, fetchFn } = fakeFetch(200, [hit]);
      const hits = await new BrainApi(fetchFn, session).testMemory("Que boit Kévin à l'aube ?");
      expect(hits).toEqual([hit]);
      const url = new URL(calls[0]?.url ?? "");
      expect(url.pathname).toBe("/memories/test");
      expect(url.searchParams.get("q")).toBe("Que boit Kévin à l'aube ?");
      expect(calls[0]?.url).not.toContain(" ");
      expect(header(calls[0], "authorization")).toBe(authorization);
    });
    test("testMemory: 401 → UnauthorizedError, 400 and malformed answers throw", async () => {
      await expect(api(401, {}).testMemory("x")).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(400, brainError("invalid_request")).testMemory("x")).rejects.toThrow(/400/);
      await expect(api(200, [{ nope: 1 }]).testMemory("x")).rejects.toThrow();
    });
  });

  describe("deleteConversation", () => {
    test.each([
      [204, null, "deleted"],
      [404, brainError("not_found"), "not_found"],
      [409, brainError("busy"), "busy"],
    ] as const)("HTTP %i → %s", async (status, body, outcome) => {
      const { calls, fetchFn } = fakeFetch(status, body);
      expect(await new BrainApi(fetchFn, session).deleteConversation(CONVERSATION_ID)).toBe(outcome);
      expect(calls[0]?.init?.method).toBe("DELETE");
      expect(calls[0]?.url).toBe(`http://127.0.0.1:8780/conversations/${CONVERSATION_ID}`);
      expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
      expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    });
    test("401 → UnauthorizedError, 5xx throws", async () => {
      const api = (status: number) => new BrainApi(fakeFetch(status, {}).fetchFn, session);
      await expect(api(401).deleteConversation(CONVERSATION_ID)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(api(500).deleteConversation(CONVERSATION_ID)).rejects.toThrow(/500/);
    });
  });
});
