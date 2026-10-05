import { createHash } from "node:crypto";
import { GOOGLE_SCOPES } from "@alicia/protocol";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_PREFIX = "/gmail/v1/users/me";
const EVENTS_PATH = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;

export interface FakeCalendar {
  id: string;
  summary: string;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
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
  refreshTokens: Set<string>;
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

/**
 * An in-memory Google (OAuth, Calendar v3, Gmail v1) behind a `fetch`, for tests and the end-to-end run.
 * Never touches the network. Any URL that would send a mail is refused (and recorded).
 */
export class FakeGoogle {
  readonly clientId = "alicia-test.apps.googleusercontent.com";
  readonly clientSecret = "alicia-test-secret";
  readonly requests: FakeRequest[] = [];
  /** Tokens revoked through the revocation endpoint. */
  readonly revoked: string[] = [];
  readonly #accounts = new Map<string, FakeAccount>();
  readonly #codes = new Map<string, { email: string; challenge: string | undefined; scopes: readonly string[] }>();
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
      email, refreshTokens: new Set(), calendars: [], events: new Map(), mails: [], drafts: [],
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

  /** A one-time authorization code, as Google hands it to the loopback redirect. */
  issueCode(email: string, options: { challenge?: string; scopes?: readonly string[] } = {}): string {
    this.addAccount(email);
    const code = this.#next("code");
    this.#codes.set(code, { email, challenge: options.challenge, scopes: options.scopes ?? GOOGLE_SCOPES });
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
    if (/\/send$/.test(url.pathname)) return apiError(400, "sending is forbidden");
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
      if (!LOOPBACK.test(params.get("redirect_uri") ?? "")) return json(400, { error: "redirect_uri_mismatch" });
      const verifier = params.get("code_verifier") ?? "";
      if (code.challenge !== undefined && createHash("sha256").update(verifier).digest("base64url") !== code.challenge) {
        return json(400, { error: "invalid_grant" });
      }
      const refreshToken = this.#next("refresh");
      this.#account(code.email).refreshTokens.add(refreshToken);
      return json(200, {
        access_token: this.#issueAccess(code.email), expires_in: 3599, refresh_token: refreshToken,
        scope: code.scopes.join(" "), token_type: "Bearer",
      });
    }
    if (grant === "refresh_token") {
      const refreshToken = params.get("refresh_token") ?? "";
      const owner = [...this.#accounts.values()].find((a) => a.refreshTokens.has(refreshToken));
      if (owner === undefined) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      return json(200, {
        access_token: this.#issueAccess(owner.email), expires_in: 3599, scope: GOOGLE_SCOPES.join(" "), token_type: "Bearer",
      });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  #revoke(token: string): Response {
    this.revoked.push(token);
    for (const account of this.#accounts.values()) account.refreshTokens.delete(token);
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
    const events = account.events.get(calendarId) ?? [];
    const eventId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    const writable = calendar.accessRole === "owner" || calendar.accessRole === "writer";

    if (eventId === undefined && method === "GET") {
      const min = Date.parse(url.searchParams.get("timeMin") ?? "");
      const max = Date.parse(url.searchParams.get("timeMax") ?? "");
      const items = events
        .filter((e) => (Number.isNaN(max) || instantOf(e["start"]) < max) && (Number.isNaN(min) || instantOf(e["end"]) > min))
        .sort((a, b) => instantOf(a["start"]) - instantOf(b["start"]));
      return json(200, { items });
    }
    if (eventId === undefined && method === "POST") {
      if (!writable) return apiError(403, "forbidden");
      const parsed = parseJson(body);
      if (!isRecord(parsed)) return apiError(400, "invalid");
      const created: FakeEvent = { status: "confirmed", ...parsed, id: this.#next("evt"), etag: this.#etag() };
      account.events.set(calendarId, [...events, created]);
      return json(200, created);
    }
    const current = events.find((e) => idOf(e) === eventId);
    if (current === undefined) return apiError(404, "notFound");
    if (method === "GET") return json(200, current);
    if (!writable) return apiError(403, "forbidden");
    // A conditional write on an event that changed since it was read: Google answers 412.
    const ifMatch = headers.get("if-match");
    if (ifMatch !== null && ifMatch !== current["etag"]) return apiError(412, "conditionNotMet");
    if (method === "DELETE") {
      account.events.set(calendarId, events.filter((e) => idOf(e) !== eventId));
      return json(204, null);
    }
    if (method === "PATCH") {
      const parsed = parseJson(body);
      if (!isRecord(parsed)) return apiError(400, "invalid");
      const updated: FakeEvent = { ...current, etag: this.#etag() };
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || key === "etag" || key === "id") continue;
        const base = current[key];
        updated[key] = (key === "start" || key === "end") && isRecord(value)
          ? Object.fromEntries(Object.entries({ ...(isRecord(base) ? base : {}), ...value }).filter(([, v]) => v !== null))
          : value;
      }
      account.events.set(calendarId, events.map((e) => (idOf(e) === eventId ? updated : e)));
      return json(200, updated);
    }
    return apiError(405, "methodNotAllowed");
  }
}
