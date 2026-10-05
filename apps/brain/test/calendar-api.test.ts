import { describe, expect, test } from "vitest";
import { CalendarApi } from "../src/google/calendar-api.ts";
import { GoogleApiError } from "../src/google/http.ts";
import { createFamilyGoogle } from "./google-fixture.ts";

describe("Calendar API", () => {
  test("calendars and events in a range", async () => {
    const { kevinAccess, accounts } = await createFamilyGoogle();
    const calendar = new CalendarApi(kevinAccess);
    expect((await calendar.calendars(accounts.famille)).map((c) => c.id)).toEqual(["famille@example.com"]);
    const events = await calendar.events(accounts.famille, "famille@example.com", {
      timeMin: "2026-10-09T22:00:00.000Z", timeMax: "2026-10-10T22:00:00.000Z",
    });
    expect(events.map((e) => e.summary)).toEqual(["Piscine"]);
  });

  test("every write tells Google not to notify anyone", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const calendar = new CalendarApi(kevinAccess);
    const created = await calendar.insert(accounts.famille, "famille@example.com", {
      summary: "Dentiste", start: { dateTime: "2026-10-12T09:00:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-12T10:00:00", timeZone: "Europe/Paris" },
    });
    await calendar.update(accounts.famille, "famille@example.com", created.id, { start: { date: "2026-10-13" }, end: { date: "2026-10-14" } });
    await calendar.remove(accounts.famille, "famille@example.com", created.id);
    const writes = google.requests.filter((r) => r.method !== "GET" && r.url.pathname.startsWith("/calendar/"));
    expect(writes.map((r) => r.method)).toEqual(["POST", "PATCH", "DELETE"]);
    for (const write of writes) expect(write.url.searchParams.get("sendUpdates")).toBe("none");
  });

  test("a patch clears the other kind of time (all-day ↔ timed)", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const calendar = new CalendarApi(kevinAccess);
    const updated = await calendar.update(accounts.famille, "famille@example.com", "evtfamille1", {
      start: { date: "2026-10-11" }, end: { date: "2026-10-12" },
    });
    expect(updated.start).toEqual({ date: "2026-10-11" });
    const patch = google.requests.find((r) => r.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}") as unknown).toEqual({
      start: { date: "2026-10-11", dateTime: null, timeZone: null },
      end: { date: "2026-10-12", dateTime: null, timeZone: null },
    });
  });

  test("an event comes with its version (etag), which changes when it is written", async () => {
    const { kevinAccess, accounts } = await createFamilyGoogle();
    const calendar = new CalendarApi(kevinAccess);
    const before = await calendar.event(accounts.famille, "famille@example.com", "evtfamille1");
    expect(before.etag).toMatch(/^".+"$/);
    const after = await calendar.update(accounts.famille, "famille@example.com", "evtfamille1", { location: "Piscine municipale" });
    expect(after.etag).toMatch(/^".+"$/);
    expect(after.etag).not.toBe(before.etag);
  });

  test("with the version read before: a write on an event changed meanwhile is refused (changed), nothing is written", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const calendar = new CalendarApi(kevinAccess);
    const seen = await calendar.event(accounts.famille, "famille@example.com", "evtfamille1");
    // Someone else edits the event in Google Agenda between the question and the yes.
    await calendar.update(accounts.famille, "famille@example.com", "evtfamille1", { location: "Ailleurs" });
    const failure = async (write: Promise<unknown>) =>
      write.then(() => "none", (error: unknown) => (error instanceof GoogleApiError ? error.failure : "other"));
    expect(await failure(calendar.update(accounts.famille, "famille@example.com", "evtfamille1", { summary: "Changé" }, seen.etag)))
      .toBe("changed");
    expect(await failure(calendar.remove(accounts.famille, "famille@example.com", "evtfamille1", seen.etag))).toBe("changed");
    expect(google.events("famille@example.com", "famille@example.com").map((e) => e["summary"])).toEqual(["Piscine"]);
    const writes = google.requests.filter((r) => r.method === "PATCH" || r.method === "DELETE");
    expect(writes.slice(-2).map((r) => r.url.searchParams.get("sendUpdates"))).toEqual(["none", "none"]);

    const current = await calendar.event(accounts.famille, "famille@example.com", "evtfamille1");
    await calendar.remove(accounts.famille, "famille@example.com", "evtfamille1", current.etag);
    expect(google.events("famille@example.com", "famille@example.com")).toEqual([]);
  });

  test("ids are escaped in the path: an event id cannot reach another calendar", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const calendar = new CalendarApi(kevinAccess);
    const failure = await calendar.event(accounts.famille, "famille@example.com", "../../kevin@example.com/events/evtkevin1")
      .then(() => "none", (error: unknown) => (error instanceof GoogleApiError ? error.failure : "other"));
    expect(failure).toBe("not_found");
    expect(google.requests.at(-1)?.url.pathname).toBe(
      "/calendar/v3/calendars/famille%40example.com/events/..%2F..%2Fkevin%40example.com%2Fevents%2Fevtkevin1",
    );
  });
});
