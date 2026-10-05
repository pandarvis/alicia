import { z } from "zod";
import type { GoogleAccount } from "./account-store.ts";
import type { GoogleRequester } from "./http.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES = 5;

export const CalendarEntry = z.object({
  id: z.string().min(1),
  summary: z.string().default(""),
  summaryOverride: z.string().optional(),
  primary: z.boolean().optional(),
  selected: z.boolean().optional(),
  accessRole: z.enum(["freeBusyReader", "reader", "writer", "owner"]),
});
export type CalendarEntry = z.infer<typeof CalendarEntry>;
const CalendarPage = z.object({ items: z.array(CalendarEntry).default([]), nextPageToken: z.string().optional() });

export const EventTime = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});
export type EventTime = z.infer<typeof EventTime>;

export const CalendarEvent = z.object({
  id: z.string().min(1),
  /** Version of the event: a conditional write (If-Match) is refused once it changed. */
  etag: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().default(""),
  description: z.string().optional(),
  location: z.string().optional(),
  start: EventTime,
  end: EventTime,
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;
const EventPage = z.object({ items: z.array(CalendarEvent).default([]), nextPageToken: z.string().optional() });

/** The only fields Alicia ever writes. Never attendees: an invitation is an e-mail. */
export interface EventFields {
  summary?: string;
  location?: string;
  description?: string;
  start?: EventTime;
  end?: EventTime;
}

/** No e-mail may leave because of Alicia: Google must never notify attendees of a change. */
const NO_NOTIFICATIONS = { sendUpdates: "none" } as const;

const eventsUrl = (calendarId: string): string => `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
const eventUrl = (calendarId: string, eventId: string): string => `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;

/** A conditional write: only on the version that was read. */
function ifMatch(etag: string | undefined): { headers?: Readonly<Record<string, string>> } {
  return etag === undefined ? {} : { headers: { "if-match": etag } };
}

/** In a patch, the other kind of time is cleared (an event is either all-day or timed). */
function patchTime(time: EventTime): Record<string, string | null> {
  return time.date !== undefined
    ? { date: time.date, dateTime: null, timeZone: null }
    : { date: null, dateTime: time.dateTime ?? null, timeZone: time.timeZone ?? null };
}

function body(fields: EventFields, patch: boolean): Record<string, unknown> {
  return {
    ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    ...(fields.location !== undefined ? { location: fields.location } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.start !== undefined ? { start: patch ? patchTime(fields.start) : fields.start } : {}),
    ...(fields.end !== undefined ? { end: patch ? patchTime(fields.end) : fields.end } : {}),
  };
}

/** Calendar v3, through a person-bound requester. Every answer is validated. */
export class CalendarApi {
  readonly #google: GoogleRequester;

  constructor(google: GoogleRequester) {
    this.#google = google;
  }

  async calendars(account: GoogleAccount): Promise<CalendarEntry[]> {
    const all: CalendarEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#google.json(account, {
        method: "GET", url: `${BASE}/users/me/calendarList`, query: { pageToken },
      }, CalendarPage);
      all.push(...result.items);
      pageToken = result.nextPageToken;
      if (pageToken === undefined) break;
    }
    return all;
  }

  /** Occurrences (recurring events expanded) between two instants, by start time. */
  async events(account: GoogleAccount, calendarId: string, range: { timeMin: string; timeMax: string }): Promise<CalendarEvent[]> {
    const all: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#google.json(account, {
        method: "GET",
        url: eventsUrl(calendarId),
        query: { ...range, singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken },
      }, EventPage);
      all.push(...result.items);
      pageToken = result.nextPageToken;
      if (pageToken === undefined) break;
    }
    return all;
  }

  event(account: GoogleAccount, calendarId: string, eventId: string): Promise<CalendarEvent> {
    return this.#google.json(account, { method: "GET", url: eventUrl(calendarId, eventId) }, CalendarEvent);
  }

  insert(account: GoogleAccount, calendarId: string, fields: EventFields): Promise<CalendarEvent> {
    return this.#google.json(account, {
      method: "POST", url: eventsUrl(calendarId), query: NO_NOTIFICATIONS, body: body(fields, false),
    }, CalendarEvent);
  }

  /** `etag`: the version the person approved; Google refuses the write ("changed") if the event changed since. */
  update(
    account: GoogleAccount, calendarId: string, eventId: string, fields: EventFields, etag?: string,
  ): Promise<CalendarEvent> {
    return this.#google.json(account, {
      method: "PATCH", url: eventUrl(calendarId, eventId), query: NO_NOTIFICATIONS, body: body(fields, true),
      ...ifMatch(etag),
    }, CalendarEvent);
  }

  /** `etag`: as for update. */
  remove(account: GoogleAccount, calendarId: string, eventId: string, etag?: string): Promise<void> {
    return this.#google.empty(account, {
      method: "DELETE", url: eventUrl(calendarId, eventId), query: NO_NOTIFICATIONS, ...ifMatch(etag),
    });
  }
}
