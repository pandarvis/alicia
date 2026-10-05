import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FakeGoogle } from "../src/google/fake-google.ts";

const REDIRECT = "http://127.0.0.1:53682";
const VERIFIER = "v".repeat(43);
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/famille%40example.com/events";
const QUIET = "?sendUpdates=none";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function form(params: Readonly<Record<string, string>>): RequestInit {
  return { method: "POST", body: new URLSearchParams(params).toString() };
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** A FakeGoogle with one account, its calendar and event, and an access token for it. */
async function setup() {
  const google = new FakeGoogle();
  google.addCalendar("famille@example.com", { id: "famille@example.com", summary: "Famille", accessRole: "owner" });
  google.addEvent("famille@example.com", "famille@example.com", {
    id: "evt1", summary: "Piscine", location: "Centre", start: { dateTime: "2026-10-10T14:00:00+02:00" },
    end: { dateTime: "2026-10-10T15:00:00+02:00" },
  });
  const response = await google.fetch(TOKEN_URL, form({
    grant_type: "authorization_code", code: google.issueCode("famille@example.com"), client_id: google.clientId,
    client_secret: google.clientSecret, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  }));
  const token = String((await jsonOf(response))["access_token"]);
  const call = (url: string, init: Omit<RequestInit, "headers"> = {}, headers: Readonly<Record<string, string>> = {}) =>
    google.fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...headers } });
  return { google, call };
}

async function etagOf(response: Response): Promise<string> {
  return String((await jsonOf(response))["etag"]);
}

describe("FakeGoogle", () => {
  test("every URL that would send a mail is refused", async () => {
    const { call } = await setup();
    for (const url of [
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
    ]) {
      expect((await call(url, { method: "POST", body: "{}" })).status, url).toBe(400);
    }
  });

  test("any Gmail route Alicia does not use is refused and recorded", async () => {
    const { google, call } = await setup();
    const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
    for (const [method, url] of [
      ["POST", `${gmail}/messages/send`], ["POST", `${gmail}/messages/m1/modify`], ["DELETE", `${gmail}/messages/m1`],
      ["GET", `${gmail}/drafts`], ["POST", `${gmail}/settings/forwardingAddresses`],
      ["POST", "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send"],
    ] as const) {
      expect((await call(url, { method, body: "{}" })).status, url).toBe(400);
    }
    expect(google.refusedRoutes.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /gmail/v1/users/me/messages/send", "POST /gmail/v1/users/me/messages/m1/modify",
      "DELETE /gmail/v1/users/me/messages/m1", "GET /gmail/v1/users/me/drafts",
      "POST /gmail/v1/users/me/settings/forwardingAddresses", "POST /upload/gmail/v1/users/me/messages/send",
    ]);
    expect((await call(`${gmail}/profile`)).status).toBe(200);
    expect(google.refusedRoutes).toHaveLength(6);
  });

  test("a calendar write that could notify anyone is refused: no sendUpdates=none, or attendees", async () => {
    const { google, call } = await setup();
    const event = { summary: "Dîner", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } };
    expect((await call(EVENTS, { method: "POST", body: JSON.stringify(event) })).status).toBe(400);
    expect((await call(`${EVENTS}?sendUpdates=all`, { method: "POST", body: JSON.stringify(event) })).status).toBe(400);
    const invite = { ...event, attendees: [{ email: "x@example.com" }] };
    expect((await call(`${EVENTS}${QUIET}`, { method: "POST", body: JSON.stringify(invite) })).status).toBe(400);
    expect((await call(`${EVENTS}/evt1`, { method: "PATCH", body: JSON.stringify({ summary: "x" }) })).status).toBe(400);
    expect((await call(`${EVENTS}/evt1${QUIET}`, { method: "PATCH", body: JSON.stringify({ attendees: [] }) })).status).toBe(400);
    expect((await call(`${EVENTS}/evt1`, { method: "DELETE" })).status).toBe(400);
    expect(google.events("famille@example.com", "famille@example.com").map((e) => e["summary"])).toEqual(["Piscine"]);
  });

  test("events carry an etag that changes on every write", async () => {
    const { call } = await setup();
    const first = await etagOf(await call(`${EVENTS}/evt1`));
    expect(first).toMatch(/^".+"$/);
    const patched = await call(`${EVENTS}/evt1${QUIET}`, { method: "PATCH", body: JSON.stringify({ summary: "Piscine (annulée)" }) });
    expect(patched.status).toBe(200);
    const second = await etagOf(patched);
    expect(second).not.toBe(first);
    const created = await call(`${EVENTS}${QUIET}`, {
      method: "POST", body: JSON.stringify({ summary: "Dentiste", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }),
    });
    expect(await etagOf(created)).toMatch(/^".+"$/);
  });

  test("a top-level null in a patch clears the field", async () => {
    const { google, call } = await setup();
    await call(`${EVENTS}/evt1${QUIET}`, { method: "PATCH", body: JSON.stringify({ location: null }) });
    expect(google.events("famille@example.com", "famille@example.com")[0]).not.toHaveProperty("location");
  });

  test("If-Match: a write on an event changed meanwhile is refused with 412, nothing changes", async () => {
    const { google, call } = await setup();
    const etag = await etagOf(await call(`${EVENTS}/evt1`));
    await call(`${EVENTS}/evt1${QUIET}`, { method: "PATCH", body: JSON.stringify({ location: "Piscine municipale" }) });
    const stalePatch = await call(`${EVENTS}/evt1${QUIET}`, { method: "PATCH", body: JSON.stringify({ summary: "Changé" }) }, {
      "if-match": etag,
    });
    expect(stalePatch.status).toBe(412);
    const staleDelete = await call(`${EVENTS}/evt1${QUIET}`, { method: "DELETE" }, { "if-match": etag });
    expect(staleDelete.status).toBe(412);
    expect(google.events("famille@example.com", "famille@example.com").map((e) => e["summary"])).toEqual(["Piscine"]);
    const current = await etagOf(await call(`${EVENTS}/evt1`));
    expect((await call(`${EVENTS}/evt1${QUIET}`, { method: "DELETE" }, { "if-match": current })).status).toBe(204);
    expect(google.events("famille@example.com", "famille@example.com")).toEqual([]);
  });

  test("an aborted request never reaches it", async () => {
    const { google, call } = await setup();
    const before = google.requests.length;
    await expect(call(`${EVENTS}/evt1`, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(google.requests).toHaveLength(before);
  });

  test("a code is exchanged only with the exact redirect it was issued for, and its PKCE verifier", async () => {
    const google = new FakeGoogle();
    const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
    const exchange = (code: string, redirect: string, verifier = VERIFIER) => google.fetch(TOKEN_URL, form({
      grant_type: "authorization_code", code, client_id: google.clientId, client_secret: google.clientSecret,
      redirect_uri: redirect, code_verifier: verifier,
    }));
    const code = () => google.issueCode("kevin@example.com", { challenge, redirectUri: REDIRECT });
    expect((await exchange(code(), "http://127.0.0.1:53683")).status).toBe(400);
    expect((await exchange(code(), REDIRECT, "w".repeat(43))).status).toBe(400);
    expect((await exchange(code(), REDIRECT)).status).toBe(200);
  });

  test("a refresh gives back the scopes actually granted", async () => {
    const google = new FakeGoogle();
    const scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
    const first = await jsonOf(await google.fetch(TOKEN_URL, form({
      grant_type: "authorization_code", code: google.issueCode("kevin@example.com", { scopes }), client_id: google.clientId,
      client_secret: google.clientSecret, redirect_uri: REDIRECT, code_verifier: VERIFIER,
    })));
    const refreshed = await jsonOf(await google.fetch(TOKEN_URL, form({
      grant_type: "refresh_token", refresh_token: String(first["refresh_token"]), client_id: google.clientId,
      client_secret: google.clientSecret,
    })));
    expect(refreshed["scope"]).toBe(scopes.join(" "));
  });

  test("revoking an unknown token: 400 invalid_token, nothing recorded", async () => {
    const google = new FakeGoogle();
    const response = await google.fetch("https://oauth2.googleapis.com/revoke", form({ token: "refresh-unknown" }));
    expect(response.status).toBe(400);
    expect((await jsonOf(response))["error"]).toBe("invalid_token");
    expect(google.revoked).toEqual([]);
  });
});
