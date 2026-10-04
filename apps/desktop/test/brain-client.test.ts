import { describe, expect, test } from "vitest";
import {
  BrainApi, normalizeServerUrl, pair, UnauthorizedError, webSocketUrl,
} from "../src/renderer/src/lib/brain-client.ts";

const CONVERSATION_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

/** Records the last request and answers with a fixed response. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetchFn };
}

describe("server URL", () => {
  test("adds http:// and strips trailing slashes", () => {
    expect(normalizeServerUrl(" 192.168.1.20:8780/ ")).toBe("http://192.168.1.20:8780");
    expect(normalizeServerUrl("https://alicia.ts.net")).toBe("https://alicia.ts.net");
  });
  test("derives the WebSocket URL", () => {
    expect(webSocketUrl("http://127.0.0.1:8780")).toBe("ws://127.0.0.1:8780/ws");
    expect(webSocketUrl("https://alicia.ts.net")).toBe("wss://alicia.ts.net/ws");
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
    [401, { error: "invalid_code" }, "invalid_code"],
    [429, { error: "too_many_attempts" }, "too_many_attempts"],
    [400, { error: "invalid_request" }, "invalid_request"],
  ] as const)("HTTP %i → %s", async (status, body, reason) => {
    const { fetchFn } = fakeFetch(status, body);
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason });
  });
  test("network failure → unreachable", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
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
    const { fetchFn } = fakeFetch(401, { error: "unauthenticated" });
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  test("malformed answer is rejected", async () => {
    const { fetchFn } = fakeFetch(200, [{ nope: true }]);
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toThrow();
  });
});
