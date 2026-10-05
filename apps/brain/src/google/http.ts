import type { z } from "zod";
import type { GoogleAccount } from "./account-store.ts";

/**
 * What went wrong with a Google call, in terms Alicia and the app can act on. "changed": a conditional write
 * (If-Match) found the target changed since it was read — nothing was written.
 */
export type GoogleFailure = "reconnect" | "not_found" | "forbidden" | "invalid" | "changed" | "unavailable";

/** Carries no token and no Google message (they can quote user data): safe to log. */
export class GoogleApiError extends Error {
  readonly failure: GoogleFailure;

  constructor(failure: GoogleFailure) {
    super(`Google call failed: ${failure}`);
    this.name = "GoogleApiError";
    this.failure = failure;
  }
}

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface ApiRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  query?: Readonly<Record<string, QueryValue>>;
  /** Sent as JSON. */
  body?: unknown;
  /** Extra headers (If-Match); never authorization, which the client sets. */
  headers?: Readonly<Record<string, string>>;
}

/** Authorized Google calls on behalf of the person a GoogleAccess is bound to. */
export interface GoogleRequester {
  json<T>(account: GoogleAccount, request: ApiRequest, schema: z.ZodType<T>): Promise<T>;
  empty(account: GoogleAccount, request: ApiRequest): Promise<void>;
}

/**
 * An id as one path segment. "", "." and ".." survive encodeURIComponent and are then resolved by the URL parser:
 * an event id ".." would turn `…/events/..` into a call on the calendar itself. They are refused before any call.
 */
export function pathSegment(id: string): string {
  if (id === "" || id === "." || id === "..") throw new GoogleApiError("invalid");
  return encodeURIComponent(id);
}

export function buildUrl(request: ApiRequest): string {
  const url = new URL(request.url);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      url.searchParams.set(name, String(value));
    } else {
      for (const item of value) url.searchParams.append(name, item);
    }
  }
  return url.href;
}

const SCOPE_MISSING = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i;
const RATE_LIMITED = /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded/;

/** A non-2xx answer as a failure. 401 only reaches here after one refresh already failed to help. */
export function failureOf(status: number, body: string): GoogleFailure {
  if (status === 401) return "reconnect";
  if (status === 403) {
    if (SCOPE_MISSING.test(body)) return "reconnect";
    return RATE_LIMITED.test(body) ? "unavailable" : "forbidden";
  }
  if (status === 404 || status === 410) return "not_found";
  if (status === 412) return "changed";
  if (status === 400) return "invalid";
  return "unavailable";
}
