import { z } from "zod";
import type { GoogleAccount } from "./account-store.ts";
import { GoogleApiError, type GoogleRequester } from "./http.ts";
import { IsoDate, Rfc3339DateTime } from "./time.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES = 5;
const PAGE_SIZE = 250;

const ACCESS_ROLES = ["freeBusyReader", "reader", "writer", "owner"] as const;

export const CalendarEntry = z.object({
  id: z.string().min(1),
  summary: z.string().default(""),
  summaryOverride: z.string().optional(),
  primary: z.boolean().optional(),
  selected: z.boolean().optional(),
  accessRole: z.enum(ACCESS_ROLES),
});
export type CalendarEntry = z.infer<typeof CalendarEntry>;

/** A start or end as Google sends it: a day (all-day event) or an instant with its offset — exactly one of them. */
export const EventTime = z
  .object({
    date: IsoDate.optional(),
    dateTime: Rfc3339DateTime.optional(),
    timeZone: z.string().optional(),
  })
  .refine((time) => (time.date === undefined) !== (time.dateTime === undefined), "date ou dateTime, pas les deux");
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
  /** Set on an occurrence of a recurring event: the id of its series. */
  recurringEventId: z.string().optional(),
  /** Set on a series itself (RRULE…): writing it changes every occurrence. */
  recurrence: z.array(z.string()).optional(),
  /** On an occurrence: where it would start without changes (what identifies it in its series). */
  originalStartTime: EventTime.optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

/** Pages are read entry by entry: one entry Alicia cannot read (a new role, an odd event) never hides the others. */
const Page = z.object({ items: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() });

function readable<T>(items: readonly unknown[], schema: z.ZodType<T>): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What Alicia writes for a start or an end: a day, or a wall-clock time and its zone (or an instant). */
export type EventTimeInput = { date: string } | { dateTime: string; timeZone?: string };

/** The only fields Alicia ever writes. Never attendees: an invitation is an e-mail. */
export interface EventFields {
  summary?: string;
  location?: string;
  description?: string;
  start?: EventTimeInput;
  end?: EventTimeInput;
}

export interface EventList {
  events: CalendarEvent[];
  /** Google had more than Alicia reads at once: the list is cut. */
  truncated: boolean;
}

/** No e-mail may leave because of Alicia: Google must never notify attendees of a change. */
const NO_NOTIFICATIONS = { sendUpdates: "none" } as const;

/**
 * One path segment. "", "." and ".." survive encodeURIComponent and are then resolved by the URL parser: an event
 * id ".." would turn `…/events/..` into a call on the calendar itself. They are refused before any call.
 */
function segment(id: string): string {
  if (id === "" || id === "." || id === "..") throw new GoogleApiError("invalid");
  return encodeURIComponent(id);
}

const eventsUrl = (calendarId: string): string => `${BASE}/calendars/${segment(calendarId)}/events`;
const eventUrl = (calendarId: string, eventId: string): string => `${eventsUrl(calendarId)}/${segment(eventId)}`;

/** A conditional write: only on the version that was read. */
function ifMatch(etag: string | undefined): { headers?: Readonly<Record<string, string>> } {
  return etag === undefined ? {} : { headers: { "if-match": etag } };
}

/** In a patch, the other kind of time is cleared (an event is either all-day or timed). */
function patchTime(time: EventTimeInput): Record<string, string | null> {
  return "date" in time
    ? { date: time.date, dateTime: null, timeZone: null }
    : { date: null, dateTime: time.dateTime, timeZone: time.timeZone ?? null };
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

  /** The account's calendars Alicia understands (an unknown role is left out). */
  async calendars(account: GoogleAccount): Promise<CalendarEntry[]> {
    const all: CalendarEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#google.json(account, {
        method: "GET", url: `${BASE}/users/me/calendarList`, query: { pageToken },
      }, Page);
      all.push(...readable(result.items, CalendarEntry));
      pageToken = result.nextPageToken;
      if (pageToken === undefined) break;
    }
    return all;
  }

  /** Occurrences (recurring events expanded) between two instants, by start time; at most a few pages. */
  async events(account: GoogleAccount, calendarId: string, range: { timeMin: string; timeMax: string }): Promise<EventList> {
    const url = eventsUrl(calendarId);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#google.json(account, {
        method: "GET", url, query: { ...range, singleEvents: true, orderBy: "startTime", maxResults: PAGE_SIZE, pageToken },
      }, Page);
      events.push(...readable(result.items, CalendarEvent));
      pageToken = result.nextPageToken;
      if (pageToken === undefined) break;
    }
    return { events, truncated: pageToken !== undefined };
  }

  async event(account: GoogleAccount, calendarId: string, eventId: string): Promise<CalendarEvent> {
    return this.#google.json(account, { method: "GET", url: eventUrl(calendarId, eventId) }, CalendarEvent);
  }

  async insert(account: GoogleAccount, calendarId: string, fields: EventFields): Promise<CalendarEvent> {
    return this.#google.json(account, {
      method: "POST", url: eventsUrl(calendarId), query: NO_NOTIFICATIONS, body: body(fields, false),
    }, CalendarEvent);
  }

  /**
   * `eventId` of an occurrence changes that occurrence only; the id of a series changes all of them.
   * `etag`: the version the person approved; Google refuses the write ("changed") if the event changed since.
   */
  async update(
    account: GoogleAccount, calendarId: string, eventId: string, fields: EventFields, etag?: string,
  ): Promise<CalendarEvent> {
    return this.#google.json(account, {
      method: "PATCH", url: eventUrl(calendarId, eventId), query: NO_NOTIFICATIONS, body: body(fields, true),
      ...ifMatch(etag),
    }, CalendarEvent);
  }

  /** `eventId`, `etag`: as for update (an occurrence alone, or the whole series). */
  async remove(account: GoogleAccount, calendarId: string, eventId: string, etag?: string): Promise<void> {
    await this.#google.empty(account, {
      method: "DELETE", url: eventUrl(calendarId, eventId), query: NO_NOTIFICATIONS, ...ifMatch(etag),
    });
  }
}
