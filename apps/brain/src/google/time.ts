import { z } from "zod";
import { GoogleApiError } from "./http.ts";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
/** An explicit UTC offset at the end of a dateTime ("Z", "+02:00"). */
const OFFSET = /(?:[zZ]|[+-]\d{2}:\d{2})$/;
/** An instant as Google sends it (RFC 3339): wall-clock, optional fraction, offset. */
const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(value: string): WallClock | undefined {
  const date = DATE.exec(value);
  if (date !== null) {
    return { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]), hour: 0, minute: 0, second: 0 };
  }
  const local = LOCAL.exec(value);
  if (local === null) return undefined;
  return {
    year: Number(local[1]), month: Number(local[2]), day: Number(local[3]),
    hour: Number(local[4]), minute: Number(local[5]), second: Number(local[6] ?? "0"),
  };
}

const utc = (w: WallClock): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** True when the value names a real day and time (no 30 February, no 25:00). */
function isReal(value: string): boolean {
  const w = wallClock(value);
  if (w === undefined) return false;
  const t = new Date(utc(w));
  return t.getUTCFullYear() === w.year && t.getUTCMonth() === w.month - 1 && t.getUTCDate() === w.day
    && t.getUTCHours() === w.hour && t.getUTCMinutes() === w.minute && t.getUTCSeconds() === w.second;
}

/** A date that does not parse came from Google (or a tool past its schema): a Google "invalid", never a crash. */
function parse(value: string): WallClock {
  const w = wallClock(value);
  if (w === undefined) throw new GoogleApiError("invalid");
  return w;
}

/** A calendar day, "2026-10-10". */
export const IsoDate = z.string().regex(DATE).refine(isReal, "Date invalide");
/** A wall-clock time in the household's time zone, without offset: "2026-10-10T14:00". */
export const LocalDateTime = z.string().regex(LOCAL).refine(isReal, "Date ou heure invalide");
/** An instant with its offset, as Google sends it: "2026-10-10T14:00:00+02:00". */
export const Rfc3339DateTime = z
  .string()
  .regex(RFC3339)
  .refine((value) => isReal(RFC3339.exec(value)?.[1] ?? ""), "Date ou heure invalide");

export function addDays(date: string, days: number): string {
  return new Date(utc(parse(date)) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(parse(to)) - utc(parse(from))) / DAY_MS);
}

/** "2026-10-10T14:00" → "2026-10-10T14:00:00", the form written to Google next to a timeZone. */
export function normalizeLocal(dateTime: string): string {
  return new Date(utc(parse(dateTime))).toISOString().slice(0, 19);
}

export function addMinutesLocal(dateTime: string, minutes: number): string {
  return new Date(utc(parse(dateTime)) + minutes * MINUTE_MS).toISOString().slice(0, 19);
}

/** Offset of a time zone at an instant, in minutes (Paris: 120 in summer, 60 in winter). */
export function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(instant))
    .find((part) => part.type === "timeZoneName")?.value;
  // No silent UTC: an offset that cannot be read is a bug, not a time zone.
  if (name === undefined) throw new Error(`No offset for time zone ${timeZone}`);
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (match === null) throw new Error(`Unexpected time zone offset: ${name}`);
  if (match[1] === undefined) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** Wall-clock time (or a day's midnight) in `timeZone` → instant; the offset is re-read at the result for DST days. */
export function localInstant(value: string, timeZone: string): number {
  const guess = utc(parse(value));
  const first = guess - zoneOffsetMinutes(guess, timeZone) * MINUTE_MS;
  return guess - zoneOffsetMinutes(first, timeZone) * MINUTE_MS;
}

/** Local midnight of a day as an RFC 3339 instant (Calendar's timeMin / timeMax). */
export function localMidnight(date: string, timeZone: string): string {
  return new Date(localInstant(date, timeZone)).toISOString();
}

/** A Google dateTime: with its offset as is, otherwise wall-clock in `timeZone`. */
export function instantOfDateTime(value: string, timeZone: string): number {
  if (!OFFSET.test(value)) return localInstant(value, timeZone);
  if (!Rfc3339DateTime.safeParse(value).success) throw new GoogleApiError("invalid");
  return Date.parse(value);
}

/** A wall-clock time in `timeZone` written with its offset, as Google returns it: "2026-10-12T09:00:00+02:00". */
export function withOffset(dateTime: string, timeZone: string): string {
  const local = normalizeLocal(dateTime);
  const offset = zoneOffsetMinutes(localInstant(local, timeZone), timeZone);
  if (offset === 0) return `${local}Z`;
  const abs = Math.abs(offset);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The household's day of an instant, "2026-10-10". */
export function localDay(instant: number, timeZone: string): string {
  // Parts, not a formatted string: the "en-CA" layout is not something ICU promises.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** "sam. 10 oct." */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(utc(parse(date))));
}

/** "sam. 10 oct., 14:00" (exact punctuation depends on the ICU version). */
export function formatDayTime(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone,
  }).format(new Date(instant));
}

/** "14:00" */
export function formatTime(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(instant));
}
