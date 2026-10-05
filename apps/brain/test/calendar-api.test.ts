import { describe, expect, test } from "vitest";
import { CalendarApi } from "../src/google/calendar-api.ts";
import { GoogleApiError } from "../src/google/http.ts";
import { createFamilyGoogle } from "./google-fixture.ts";

const FAMILLE = "famille@example.com";
const OCTOBER_10 = { timeMin: "2026-10-09T22:00:00.000Z", timeMax: "2026-10-10T22:00:00.000Z" };

/** The failure a Google call ends with ("none" when it succeeds). */
function failureOf(call: Promise<unknown>): Promise<string> {
  return call.then(() => "none", (error: unknown) => (error instanceof GoogleApiError ? error.failure : "other"));
}

async function setup() {
  const family = await createFamilyGoogle();
  return { ...family, calendar: new CalendarApi(family.kevinAccess) };
}

/** Swimming every Saturday at 10:00, three times, in the household calendar. */
function addWeeklySwim(family: Awaited<ReturnType<typeof setup>>) {
  family.google.addEvent(FAMILLE, FAMILLE, {
    id: "swim", summary: "Natation", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    start: { dateTime: "2026-10-10T10:00:00+02:00", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-10-10T11:00:00+02:00", timeZone: "Europe/Paris" },
  });
}

describe("Calendar API", () => {
  test("calendars and events in a range", async () => {
    const { calendar, accounts } = await setup();
    expect((await calendar.calendars(accounts.famille)).map((c) => c.id)).toEqual([FAMILLE]);
    const listed = await calendar.events(accounts.famille, FAMILLE, OCTOBER_10);
    expect(listed.events.map((e) => e.summary)).toEqual(["Piscine"]);
    expect(listed.truncated).toBe(false);
  });

  test("a calendar with a role Alicia does not know is left out, the others are listed", async () => {
    const { calendar, accounts, google } = await setup();
    google.addCalendar(FAMILLE, { id: "odd@example.com", summary: "Bizarre", accessRole: "superOwner" });
    expect((await calendar.calendars(accounts.famille)).map((c) => c.id)).toEqual([FAMILLE]);
  });

  test("every write tells Google not to notify anyone", async () => {
    const { calendar, accounts, google } = await setup();
    const created = await calendar.insert(accounts.famille, FAMILLE, {
      summary: "Dentiste", start: { dateTime: "2026-10-12T09:00:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-12T10:00:00", timeZone: "Europe/Paris" },
    });
    expect(created.start).toEqual({ dateTime: "2026-10-12T09:00:00+02:00", timeZone: "Europe/Paris" });
    await calendar.update(accounts.famille, FAMILLE, created.id, { start: { date: "2026-10-13" }, end: { date: "2026-10-14" } });
    await calendar.remove(accounts.famille, FAMILLE, created.id);
    const writes = google.requests.filter((r) => r.method !== "GET" && r.url.pathname.startsWith("/calendar/"));
    expect(writes.map((r) => r.method)).toEqual(["POST", "PATCH", "DELETE"]);
    for (const write of writes) expect(write.url.searchParams.get("sendUpdates")).toBe("none");
  });

  test("a patch clears the other kind of time (all-day ↔ timed)", async () => {
    const { calendar, accounts, google } = await setup();
    const updated = await calendar.update(accounts.famille, FAMILLE, "evtfamille1", {
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
    const { calendar, accounts } = await setup();
    const before = await calendar.event(accounts.famille, FAMILLE, "evtfamille1");
    expect(before.etag).toMatch(/^".+"$/);
    const after = await calendar.update(accounts.famille, FAMILLE, "evtfamille1", { location: "Piscine municipale" });
    expect(after.etag).toMatch(/^".+"$/);
    expect(after.etag).not.toBe(before.etag);
  });

  test("with the version read before: a write on an event changed meanwhile is refused (changed), nothing is written", async () => {
    const { calendar, accounts, google } = await setup();
    const seen = await calendar.event(accounts.famille, FAMILLE, "evtfamille1");
    // Someone else edits the event in Google Agenda between the question and the yes.
    await calendar.update(accounts.famille, FAMILLE, "evtfamille1", { location: "Ailleurs" });
    expect(await failureOf(calendar.update(accounts.famille, FAMILLE, "evtfamille1", { summary: "Changé" }, seen.etag)))
      .toBe("changed");
    expect(await failureOf(calendar.remove(accounts.famille, FAMILLE, "evtfamille1", seen.etag))).toBe("changed");
    expect(google.events(FAMILLE, FAMILLE).map((e) => e["summary"])).toEqual(["Piscine"]);
    const writes = google.requests.filter((r) => r.method === "PATCH" || r.method === "DELETE");
    expect(writes.slice(-2).map((r) => r.url.searchParams.get("sendUpdates"))).toEqual(["none", "none"]);

    const current = await calendar.event(accounts.famille, FAMILLE, "evtfamille1");
    await calendar.remove(accounts.famille, FAMILLE, "evtfamille1", current.etag);
    expect(google.events(FAMILLE, FAMILLE)).toEqual([]);
  });

  test("ids are escaped in the path: an event id cannot reach another calendar", async () => {
    const { calendar, accounts, google } = await setup();
    expect(await failureOf(calendar.event(accounts.famille, FAMILLE, "../../kevin@example.com/events/evtkevin1"))).toBe("not_found");
    expect(google.requests.at(-1)?.url.pathname).toBe(
      "/calendar/v3/calendars/famille%40example.com/events/..%2F..%2Fkevin%40example.com%2Fevents%2Fevtkevin1",
    );
  });

  test("ids '..', '.' and '' are refused before any call: the URL would climb to the calendar itself", async () => {
    const { calendar, accounts, google } = await setup();
    const before = google.requests.length;
    for (const id of ["..", ".", ""]) {
      expect(await failureOf(calendar.event(accounts.famille, FAMILLE, id)), `event ${id}`).toBe("invalid");
      expect(await failureOf(calendar.remove(accounts.famille, FAMILLE, id)), `remove ${id}`).toBe("invalid");
      expect(await failureOf(calendar.update(accounts.famille, FAMILLE, id, { summary: "x" })), `update ${id}`).toBe("invalid");
      expect(await failureOf(calendar.event(accounts.famille, id, "evtfamille1")), `calendar ${id}`).toBe("invalid");
      expect(await failureOf(calendar.events(accounts.famille, id, OCTOBER_10)), `events ${id}`).toBe("invalid");
      expect(await failureOf(calendar.insert(accounts.famille, id, { summary: "x" })), `insert ${id}`).toBe("invalid");
    }
    expect(google.requests.length).toBe(before);
    expect(google.events(FAMILLE, FAMILLE).map((e) => e["id"])).toEqual(["evtfamille1"]);
  });

  test("recurring events: occurrences listed one by one, each knowing its series", async () => {
    const family = await setup();
    addWeeklySwim(family);
    const { calendar, accounts } = family;
    const october = await calendar.events(accounts.famille, FAMILLE, {
      timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z",
    });
    const swims = october.events.filter((e) => e.summary === "Natation");
    expect(swims.map((e) => e.start.dateTime)).toEqual([
      "2026-10-10T10:00:00+02:00", "2026-10-17T10:00:00+02:00", "2026-10-24T10:00:00+02:00",
    ]);
    for (const swim of swims) {
      expect(swim.recurringEventId).toBe("swim");
      expect(swim.originalStartTime?.dateTime).toBe(swim.start.dateTime);
      expect(swim.id).not.toBe("swim");
    }
    const series = await calendar.event(accounts.famille, FAMILLE, "swim");
    expect(series.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=3"]);
    expect(series.recurringEventId).toBeUndefined();
  });

  test("recurring events: an occurrence is changed or deleted alone, the series stays", async () => {
    const family = await setup();
    addWeeklySwim(family);
    const { calendar, accounts } = family;
    const range = { timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z" };
    const [first, second] = (await calendar.events(accounts.famille, FAMILLE, range)).events.filter((e) => e.summary === "Natation");
    await calendar.update(accounts.famille, FAMILLE, first?.id ?? "", { location: "Piscine Nord" }, first?.etag);
    await calendar.remove(accounts.famille, FAMILLE, second?.id ?? "", second?.etag);
    const after = (await calendar.events(accounts.famille, FAMILLE, range)).events.filter((e) => e.summary === "Natation");
    expect(after.map((e) => [e.start.dateTime, e.location])).toEqual([
      ["2026-10-10T10:00:00+02:00", "Piscine Nord"], ["2026-10-24T10:00:00+02:00", undefined],
    ]);
    expect((await calendar.event(accounts.famille, FAMILLE, "swim")).recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=3"]);
  });

  test("event times are strict: one of date or dateTime, real values; a bad event is left out of a list", async () => {
    const { calendar, accounts, google } = await setup();
    google.addEvent(FAMILLE, FAMILLE, {
      id: "both", summary: "Les deux", start: { date: "2026-10-10", dateTime: "2026-10-10T09:00:00+02:00" },
      end: { date: "2026-10-11" },
    });
    google.addEvent(FAMILLE, FAMILLE, {
      id: "garbage", summary: "N'importe quoi", start: { dateTime: "samedi" }, end: { dateTime: "dimanche" },
    });
    google.addEvent(FAMILLE, FAMILLE, { id: "none", summary: "Sans heure", start: {}, end: {} });
    expect(await failureOf(calendar.event(accounts.famille, FAMILLE, "both"))).toBe("unavailable");
    expect(await failureOf(calendar.event(accounts.famille, FAMILLE, "garbage"))).toBe("unavailable");
    expect(await failureOf(calendar.event(accounts.famille, FAMILLE, "none"))).toBe("unavailable");
    const listed = await calendar.events(accounts.famille, FAMILLE, {
      timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z",
    });
    expect(listed.events.map((e) => e.id)).toEqual(["evtfamille1"]);
  });

  test("a very long list stops after a few pages and says it was cut", async () => {
    const { calendar, accounts, google } = await setup();
    for (let i = 0; i < 1300; i++) {
      google.addEvent(FAMILLE, FAMILLE, {
        id: `many${i}`, summary: `Rappel ${i}`,
        start: { dateTime: "2026-10-20T08:00:00+02:00" }, end: { dateTime: "2026-10-20T08:05:00+02:00" },
      });
    }
    const listed = await calendar.events(accounts.famille, FAMILLE, {
      timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z",
    });
    expect(listed.events).toHaveLength(1250);
    expect(listed.truncated).toBe(true);
    expect(google.requests.filter((r) => r.url.pathname.endsWith("/events")).map((r) => r.url.searchParams.get("pageToken")))
      .toEqual([null, "250", "500", "750", "1000"]);
  });
});
