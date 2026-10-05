import { createHash } from "node:crypto";
import { GOOGLE_SCOPES } from "@alicia/protocol";
import { addDays, withOffset } from "./time.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_PREFIX = "/gmail/v1/users/me";
const EVENTS_PATH = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;

export interface FakeCalendar {
  id: string;
  summary: string;
  /** Google's roles are freeBusyReader, reader, writer, owner; any other string tests an unknown one. */
  accessRole: string;
  primary?: boolean;
  selected?: boolean;
}

/** A Calendar event as Google keeps it: the JSON that was written, plus an id. */
export type FakeEvent = Record<string, unknown>;

export interface FakeMail {
  id: string;
  threadId?: string;
  from: string;
  to: string;
  subject: string;
  /** Date header (RFC 2822). */
  date: string;
  /** Gmail's internalDate (epoch ms). */
  receivedAt: number;
  text?: string;
  html?: string;
  charset?: "utf-8" | "latin1";
  unread?: boolean;
  attachments?: readonly string[];
  messageId?: string;
}

export interface FakeDraft {
  id: string;
  raw: string;
  threadId: string | undefined;
}

/** One request seen by the fake; `email` is the account behind the access token, if any. */
export interface FakeRequest {
  method: string;
  url: URL;
  email: string | undefined;
  body: string;
}

interface FakeAccount {
  email: string;
  /** Refresh tokens of this account, with the scopes each one was granted. */
  refreshTokens: Map<string, readonly string[]>;
  calendars: FakeCalendar[];
  events: Map<string, FakeEvent[]>;
  mails: FakeMail[];
  drafts: FakeDraft[];
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function apiError(code: number, reason: string): Response {
  return json(code, { error: { code, message: reason, errors: [{ reason }] } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function idOf(event: FakeEvent): string {
  return typeof event["id"] === "string" ? event["id"] : "";
}

/** Start or end of an event as an instant (all-day dates and wall-clock times read as UTC: enough for tests). */
function instantOf(time: unknown): number {
  if (!isRecord(time)) return Number.NaN;
  const value = typeof time["dateTime"] === "string" ? time["dateTime"] : typeof time["date"] === "string" ? time["date"] : "";
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) || !value.includes("T") ? value : `${value}Z`);
}

const DAY_MS = 86_400_000;
/** The only recurrence rules the fake understands: enough to test occurrences and series. */
const RULE = /^RRULE:FREQ=(DAILY|WEEKLY);COUNT=(\d{1,3})$/;
const TRAILING_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;

function ruleOf(event: FakeEvent): { stepDays: number; count: number } | undefined {
  const recurrence = event["recurrence"];
  const first = Array.isArray(recurrence) ? recurrence.find((r): r is string => typeof r === "string") : undefined;
  const match = first === undefined ? null : RULE.exec(first);
  if (match === null) return undefined;
  return { stepDays: match[1] === "DAILY" ? 1 : 7, count: Number(match[2]) };
}

/** A start or end moved by whole days, written as the original was (same offset for a dateTime). */
function shift(time: unknown, days: number): unknown {
  if (!isRecord(time)) return time;
  const date = time["date"];
  if (typeof date === "string") return { ...time, date: addDays(date, days) };
  const dateTime = time["dateTime"];
  if (typeof dateTime !== "string") return time;
  const offset = TRAILING_OFFSET.exec(dateTime)?.[0] ?? "Z";
  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetMs = offset === "Z" ? 0 : sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000;
  const local = new Date(Date.parse(dateTime) + days * DAY_MS + offsetMs).toISOString().slice(0, 19);
  return { ...time, dateTime: `${local}${offset}` };
}

/** Google's instance id suffix: the original start, in UTC ("20261010T080000Z") or the day ("20261010"). */
function suffixOf(start: unknown): string {
  if (!isRecord(start)) return "";
  if (typeof start["date"] === "string") return start["date"].replaceAll("-", "");
  const dateTime = typeof start["dateTime"] === "string" ? start["dateTime"] : "";
  return new Date(Date.parse(dateTime)).toISOString().replace(/\.\d{3}/u, "").replaceAll("-", "").replaceAll(":", "");
}

/** The occurrences of a recurring event, as `singleEvents=true` lists them. */
function occurrences(master: FakeEvent, rule: { stepDays: number; count: number }): FakeEvent[] {
  const fields = Object.fromEntries(Object.entries(master).filter(([key]) => key !== "recurrence"));
  const etag = typeof master["etag"] === "string" ? master["etag"].replaceAll("\"", "") : "";
  return Array.from({ length: rule.count }, (_, index) => {
    const start = shift(master["start"], index * rule.stepDays);
    return {
      ...fields,
      id: `${idOf(master)}_${suffixOf(start)}`,
      etag: `"${etag}-${index}"`,
      recurringEventId: idOf(master),
      originalStartTime: start,
      start,
      end: shift(master["end"], index * rule.stepDays),
    };
  });
}

/** Single events and every occurrence of the series, exceptions (changed or cancelled occurrences) applied. */
function expand(stored: readonly FakeEvent[]): FakeEvent[] {
  const exceptions = new Map(stored.filter((e) => typeof e["recurringEventId"] === "string").map((e) => [idOf(e), e]));
  return stored.flatMap((event) => {
    if (typeof event["recurringEventId"] === "string") return [];
    const rule = ruleOf(event);
    if (rule === undefined) return [event];
    return occurrences(event, rule).map((occurrence) => exceptions.get(idOf(occurrence)) ?? occurrence);
  });
}

/** Like Google: a wall-clock dateTime written with a timeZone comes back with its offset. */
function withOffsets(event: FakeEvent): FakeEvent {
  const fix = (time: unknown): unknown => {
    if (!isRecord(time)) return time;
    const dateTime = time["dateTime"];
    const timeZone = time["timeZone"];
    if (typeof dateTime !== "string" || typeof timeZone !== "string" || TRAILING_OFFSET.test(dateTime)) return time;
    try {
      return { ...time, dateTime: withOffset(dateTime, timeZone) };
    } catch {
      return time;
    }
  };
  return { ...event, start: fix(event["start"]), end: fix(event["end"]) };
}

/** A PATCH: fields replaced, start / end merged, a null clears (top level and inside start / end). */
function applyPatch(current: FakeEvent, patch: Record<string, unknown>): FakeEvent {
  const merged: FakeEvent = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "etag" || key === "id") continue;
    const base = current[key];
    merged[key] = (key === "start" || key === "end") && isRecord(value)
      ? Object.fromEntries(Object.entries({ ...(isRecord(base) ? base : {}), ...value }).filter(([, v]) => v !== null))
      : value;
  }
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null));
}

/** events.list: a time range, occurrences when singleEvents=true, by start, in pages (pageToken = offset). */
function listEvents(stored: readonly FakeEvent[], query: URLSearchParams): Response {
  const min = Date.parse(query.get("timeMin") ?? "");
  const max = Date.parse(query.get("timeMax") ?? "");
  const all = (query.get("singleEvents") === "true" ? expand(stored) : stored.filter((e) => typeof e["recurringEventId"] !== "string"))
    .filter((e) => e["status"] !== "cancelled")
    .filter((e) => (Number.isNaN(max) || instantOf(e["start"]) < max) && (Number.isNaN(min) || instantOf(e["end"]) > min))
    .sort((a, b) => instantOf(a["start"]) - instantOf(b["start"]));
  const size = Number(query.get("maxResults") ?? "250");
  const from = Number(query.get("pageToken") ?? "0");
  const next = from + size;
  return json(200, { items: all.slice(from, next), ...(next < all.length ? { nextPageToken: String(next) } : {}) });
}

/** The Gmail routes Alicia uses (the brain checks them too, before any call). */
function isAlicias(method: string, path: string): boolean {
  if (!path.startsWith(`${GMAIL_PREFIX}/`)) return false;
  const route = path.slice(GMAIL_PREFIX.length);
  if (method === "GET") return route === "/profile" || route === "/messages" || /^\/messages\/[^/]+$/.test(route);
  return method === "POST" && route === "/drafts";
}

/**
 * An in-memory Google (OAuth, Calendar v3, Gmail v1) behind a `fetch`, for tests and the end-to-end run.
 * Never touches the network. Any URL that would send a mail is refused (and recorded).
 */
export class FakeGoogle {
  readonly clientId = "alicia-test.apps.googleusercontent.com";
  readonly clientSecret = "alicia-test-secret";
  readonly requests: FakeRequest[] = [];
  /** Calls to a Gmail route Alicia never uses (sending, deleting, settings…): answered 400. Tests expect none. */
  readonly refusedRoutes: FakeRequest[] = [];
  /** Tokens revoked through the revocation endpoint. */
  readonly revoked: string[] = [];
  readonly #accounts = new Map<string, FakeAccount>();
  readonly #codes = new Map<string, {
    email: string; challenge: string | undefined; scopes: readonly string[]; redirectUri: string | undefined;
  }>();
  readonly #accessTokens = new Map<string, string>();
  readonly #failures: { status: number; reason: string }[] = [];
  #counter = 0;

  readonly fetch: typeof fetch = (input, init) => {
    // Like the real fetch: an aborted request (turn over, timeout) never leaves.
    if (init?.signal?.aborted === true) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(this.#handle(init?.method ?? "GET", url, new Headers(init?.headers), body));
  };

  addAccount(email: string): void {
    if (this.#accounts.has(email)) return;
    this.#accounts.set(email, {
      email, refreshTokens: new Map(), calendars: [], events: new Map(), mails: [], drafts: [],
    });
  }

  addCalendar(email: string, calendar: FakeCalendar): void {
    this.#account(email).calendars.push(calendar);
  }

  addEvent(email: string, calendarId: string, event: { id: string } & FakeEvent): void {
    const account = this.#account(email);
    account.events.set(calendarId, [
      ...(account.events.get(calendarId) ?? []), { status: "confirmed", ...event, etag: this.#etag() },
    ]);
  }

  events(email: string, calendarId: string): FakeEvent[] {
    return this.#account(email).events.get(calendarId) ?? [];
  }

  addMail(email: string, mail: FakeMail): void {
    this.#account(email).mails.push(mail);
  }

  drafts(email: string): FakeDraft[] {
    return this.#account(email).drafts;
  }

  /**
   * A one-time authorization code, as Google hands it to the loopback redirect. `redirectUri`: the exact address
   * the flow started with (the exchange must repeat it); without it, any loopback address passes.
   */
  issueCode(email: string, options: { challenge?: string; scopes?: readonly string[]; redirectUri?: string } = {}): string {
    this.addAccount(email);
    const code = this.#next("code");
    this.#codes.set(code, {
      email, challenge: options.challenge, scopes: options.scopes ?? GOOGLE_SCOPES, redirectUri: options.redirectUri,
    });
    return code;
  }

  /** The person removed Alicia from their Google account: refreshing now fails with invalid_grant. */
  revokeGrant(email: string): void {
    this.#account(email).refreshTokens.clear();
  }

  /** Every access token expires: Google answers 401 until the next refresh. */
  expireAccessTokens(): void {
    this.#accessTokens.clear();
  }

  /** The next API call (not OAuth) fails with this status. */
  failNext(status: number, reason: string): void {
    this.#failures.push({ status, reason });
  }

  #account(email: string): FakeAccount {
    this.addAccount(email);
    const account = this.#accounts.get(email);
    if (account === undefined) throw new Error(`FakeGoogle: no account ${email}`);
    return account;
  }

  #next(prefix: string): string {
    this.#counter += 1;
    return `${prefix}-${this.#counter}`;
  }

  /** A new version tag, quoted like Google's. */
  #etag(): string {
    return `"${this.#next("etag")}"`;
  }

  #issueAccess(email: string): string {
    const token = this.#next("access");
    this.#accessTokens.set(token, email);
    return token;
  }

  #handle(method: string, url: URL, headers: Headers, body: string): Response {
    const token = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
    const email = token === undefined ? undefined : this.#accessTokens.get(token);
    this.requests.push({ method, url, email, body });
    if (url.href === TOKEN_URL && method === "POST") return this.#token(new URLSearchParams(body));
    if (url.href === REVOKE_URL && method === "POST") return this.#revoke(new URLSearchParams(body).get("token") ?? "");
    if (/\/send$/.test(url.pathname) || (url.hostname === "gmail.googleapis.com" && !isAlicias(method, url.pathname))) {
      this.refusedRoutes.push({ method, url, email, body });
      return apiError(400, "route not used by Alicia");
    }
    if (email === undefined) return apiError(401, "authError");
    const failure = this.#failures.shift();
    if (failure !== undefined) return apiError(failure.status, failure.reason);
    const account = this.#account(email);
    if (url.hostname === "gmail.googleapis.com" && url.pathname.startsWith(GMAIL_PREFIX)) {
      return this.#gmail(account, method, url.pathname.slice(GMAIL_PREFIX.length), url.searchParams, body);
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3/")) {
      return this.#calendar(account, method, url, headers, body);
    }
    return apiError(404, "notFound");
  }

  #token(params: URLSearchParams): Response {
    if (params.get("client_id") !== this.clientId || params.get("client_secret") !== this.clientSecret) {
      return json(401, { error: "invalid_client" });
    }
    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      const code = this.#codes.get(params.get("code") ?? "");
      if (code === undefined) return json(400, { error: "invalid_grant" });
      this.#codes.delete(params.get("code") ?? "");
      const redirect = params.get("redirect_uri") ?? "";
      if (code.redirectUri === undefined ? !LOOPBACK.test(redirect) : redirect !== code.redirectUri) {
        return json(400, { error: "redirect_uri_mismatch" });
      }
      const verifier = params.get("code_verifier") ?? "";
      if (code.challenge !== undefined && createHash("sha256").update(verifier).digest("base64url") !== code.challenge) {
        return json(400, { error: "invalid_grant" });
      }
      const refreshToken = this.#next("refresh");
      this.#account(code.email).refreshTokens.set(refreshToken, code.scopes);
      return json(200, {
        access_token: this.#issueAccess(code.email), expires_in: 3599, refresh_token: refreshToken,
        scope: code.scopes.join(" "), token_type: "Bearer",
      });
    }
    if (grant === "refresh_token") {
      const refreshToken = params.get("refresh_token") ?? "";
      const owner = [...this.#accounts.values()].find((a) => a.refreshTokens.has(refreshToken));
      const granted = owner?.refreshTokens.get(refreshToken);
      if (owner === undefined || granted === undefined) {
        return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      }
      return json(200, {
        access_token: this.#issueAccess(owner.email), expires_in: 3599, scope: granted.join(" "), token_type: "Bearer",
      });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  #revoke(token: string): Response {
    const owner = [...this.#accounts.values()].find((a) => a.refreshTokens.has(token));
    if (owner === undefined) return json(400, { error: "invalid_token" });
    owner.refreshTokens.delete(token);
    this.revoked.push(token);
    return json(200, {});
  }

  #gmail(account: FakeAccount, method: string, path: string, query: URLSearchParams, body: string): Response {
    if (method === "GET" && path === "/profile") {
      return json(200, { emailAddress: account.email, messagesTotal: account.mails.length });
    }
    if (method === "GET" && path === "/messages") {
      const q = (query.get("q") ?? "").toLowerCase();
      const words = q.split(/\s+/).filter((w) => w !== "" && !w.includes(":"));
      const unreadOnly = q.includes("is:unread");
      const max = Number(query.get("maxResults") ?? "100");
      const found = account.mails
        .filter((m) => (!unreadOnly || m.unread === true)
          && words.every((w) => `${m.from} ${m.subject} ${m.text ?? ""} ${m.html ?? ""}`.toLowerCase().includes(w)))
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, max);
      return json(200, found.length === 0
        ? { resultSizeEstimate: 0 }
        : { messages: found.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })), resultSizeEstimate: found.length });
    }
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (method === "GET" && message !== null) {
      const mail = account.mails.find((m) => m.id === decodeURIComponent(message[1] ?? ""));
      return mail === undefined ? apiError(404, "notFound") : json(200, this.#message(mail));
    }
    if (method === "POST" && path === "/drafts") {
      const parsed = parseJson(body);
      const draftMessage = isRecord(parsed) ? parsed["message"] : undefined;
      if (!isRecord(draftMessage) || typeof draftMessage["raw"] !== "string") return apiError(400, "invalidArgument");
      const draft: FakeDraft = {
        id: this.#next("draft"),
        raw: draftMessage["raw"],
        threadId: typeof draftMessage["threadId"] === "string" ? draftMessage["threadId"] : undefined,
      };
      account.drafts.push(draft);
      return json(200, { id: draft.id, message: { id: this.#next("msg"), threadId: draft.threadId ?? this.#next("thread") } });
    }
    return apiError(404, "notFound");
  }

  #message(mail: FakeMail): Record<string, unknown> {
    const latin1 = mail.charset === "latin1";
    const encode = (text: string): string => Buffer.from(text, latin1 ? "latin1" : "utf8").toString("base64url");
    const part = (mimeType: string, content: string) => ({
      mimeType, filename: "",
      headers: [{ name: "Content-Type", value: `${mimeType}; charset="${latin1 ? "ISO-8859-1" : "UTF-8"}"` }],
      body: { size: content.length, data: encode(content) },
    });
    const alternatives = [
      ...(mail.text !== undefined ? [part("text/plain", mail.text)] : []),
      ...(mail.html !== undefined ? [part("text/html", mail.html)] : []),
    ];
    const attachments = (mail.attachments ?? []).map((filename, index) => ({
      mimeType: "application/pdf", filename, headers: [], body: { size: 1000, attachmentId: `att-${index}` },
    }));
    return {
      id: mail.id,
      threadId: mail.threadId ?? mail.id,
      snippet: (mail.text ?? mail.html ?? "").slice(0, 100),
      labelIds: mail.unread === true ? ["INBOX", "UNREAD"] : ["INBOX"],
      internalDate: String(mail.receivedAt),
      payload: {
        mimeType: "multipart/mixed",
        filename: "",
        headers: [
          { name: "From", value: mail.from },
          { name: "To", value: mail.to },
          { name: "Subject", value: mail.subject },
          { name: "Date", value: mail.date },
          ...(mail.messageId !== undefined ? [{ name: "Message-ID", value: mail.messageId }] : []),
        ],
        body: { size: 0 },
        parts: [{ mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: alternatives }, ...attachments],
      },
    };
  }

  #calendar(account: FakeAccount, method: string, url: URL, headers: Headers, body: string): Response {
    if (method === "GET" && url.pathname === "/calendar/v3/users/me/calendarList") {
      return json(200, { items: account.calendars });
    }
    const match = EVENTS_PATH.exec(url.pathname);
    if (match === null) return apiError(404, "notFound");
    const calendarId = decodeURIComponent(match[1] ?? "");
    const calendar = account.calendars.find((c) => c.id === calendarId);
    if (calendar === undefined) return apiError(404, "notFound");
    const eventId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (method !== "GET") {
      // Structural guard, stricter than Google: a write that could e-mail anyone never passes here.
      if (url.searchParams.get("sendUpdates") !== "none") return apiError(400, "sendUpdates must be none");
      const parsed = parseJson(body);
      if (isRecord(parsed) && "attendees" in parsed) return apiError(400, "attendees are forbidden");
    }
    const writable = calendar.accessRole === "owner" || calendar.accessRole === "writer";
    const stored = account.events.get(calendarId) ?? [];
    const save = (events: FakeEvent[]): void => {
      account.events.set(calendarId, events);
    };

    if (eventId === undefined && method === "GET") return listEvents(stored, url.searchParams);
    if (eventId === undefined && method === "POST") {
      if (!writable) return apiError(403, "forbidden");
      const parsed = parseJson(body);
      if (!isRecord(parsed)) return apiError(400, "invalid");
      const created = withOffsets({ status: "confirmed", ...parsed, id: this.#next("evt"), etag: this.#etag() });
      save([...stored, created]);
      return json(200, created);
    }
    if (eventId === undefined) return apiError(405, "methodNotAllowed");
    const isStored = stored.some((e) => idOf(e) === eventId);
    const current = stored.find((e) => idOf(e) === eventId) ?? expand(stored).find((e) => idOf(e) === eventId);
    if (current === undefined) return apiError(404, "notFound");
    if (method === "GET") return json(200, current);
    if (!writable) return apiError(403, "forbidden");
    // A conditional write on an event that changed since it was read: Google answers 412.
    const ifMatch = headers.get("if-match");
    if (ifMatch !== null && ifMatch !== current["etag"]) return apiError(412, "conditionNotMet");
    /** An occurrence changed alone becomes an exception of its series (stored next to it). */
    const keep = (event: FakeEvent): void => {
      save(isStored ? stored.map((e) => (idOf(e) === eventId ? event : e)) : [...stored, event]);
    };
    if (method === "DELETE") {
      if (typeof current["recurringEventId"] === "string") {
        keep({ ...current, status: "cancelled", etag: this.#etag() });
      } else {
        // A single event, or a whole series with its exceptions.
        save(stored.filter((e) => idOf(e) !== eventId && e["recurringEventId"] !== eventId));
      }
      return json(204, null);
    }
    if (method === "PATCH") {
      const parsed = parseJson(body);
      if (!isRecord(parsed)) return apiError(400, "invalid");
      const updated = withOffsets({ ...applyPatch(current, parsed), etag: this.#etag() });
      keep(updated);
      return json(200, updated);
    }
    return apiError(405, "methodNotAllowed");
  }
}
