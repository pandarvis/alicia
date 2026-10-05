import { describe, expect, test } from "vitest";
import { FakeGoogle } from "../src/google/fake-google.ts";

const REDIRECT = "http://127.0.0.1:53682";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/famille%40example.com/events";

/** A FakeGoogle with one account, its calendar and event, and an access token for it. */
async function setup() {
  const google = new FakeGoogle();
  google.addCalendar("famille@example.com", { id: "famille@example.com", summary: "Famille", accessRole: "owner" });
  google.addEvent("famille@example.com", "famille@example.com", {
    id: "evt1", summary: "Piscine", start: { dateTime: "2026-10-10T14:00:00+02:00" }, end: { dateTime: "2026-10-10T15:00:00+02:00" },
  });
  const response = await google.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", code: google.issueCode("famille@example.com"), client_id: google.clientId,
      client_secret: google.clientSecret, redirect_uri: REDIRECT, code_verifier: "v".repeat(43),
    }).toString(),
  });
  const token = String((await response.json() as { access_token: unknown }).access_token);
  const call = (url: string, init: Omit<RequestInit, "headers"> = {}, headers: Readonly<Record<string, string>> = {}) =>
    google.fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...headers } });
  return { google, call };
}

async function etagOf(response: Response): Promise<string> {
  return String((await response.json() as { etag: unknown }).etag);
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

  test("events carry an etag that changes on every write", async () => {
    const { call } = await setup();
    const first = await etagOf(await call(`${EVENTS}/evt1`));
    expect(first).toMatch(/^".+"$/);
    const patched = await call(`${EVENTS}/evt1`, { method: "PATCH", body: JSON.stringify({ summary: "Piscine (annulée)" }) });
    expect(patched.status).toBe(200);
    const second = await etagOf(patched);
    expect(second).not.toBe(first);
    const created = await call(EVENTS, {
      method: "POST", body: JSON.stringify({ summary: "Dentiste", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }),
    });
    expect(await etagOf(created)).toMatch(/^".+"$/);
  });

  test("If-Match: a write on an event changed meanwhile is refused with 412, nothing changes", async () => {
    const { google, call } = await setup();
    const etag = await etagOf(await call(`${EVENTS}/evt1`));
    await call(`${EVENTS}/evt1`, { method: "PATCH", body: JSON.stringify({ location: "Piscine municipale" }) });
    const stalePatch = await call(`${EVENTS}/evt1`, { method: "PATCH", body: JSON.stringify({ summary: "Changé" }) }, { "if-match": etag });
    expect(stalePatch.status).toBe(412);
    const staleDelete = await call(`${EVENTS}/evt1`, { method: "DELETE" }, { "if-match": etag });
    expect(staleDelete.status).toBe(412);
    expect(google.events("famille@example.com", "famille@example.com").map((e) => e["summary"])).toEqual(["Piscine"]);
    const current = await etagOf(await call(`${EVENTS}/evt1`));
    expect((await call(`${EVENTS}/evt1`, { method: "DELETE" }, { "if-match": current })).status).toBe(204);
    expect(google.events("famille@example.com", "famille@example.com")).toEqual([]);
  });

  test("an aborted request never reaches it", async () => {
    const { google, call } = await setup();
    const before = google.requests.length;
    await expect(call(`${EVENTS}/evt1`, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(google.requests).toHaveLength(before);
  });
});
