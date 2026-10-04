import { ConversationSummary, HistoryMessage, PairingResponse } from "@alicia/protocol";
import { z } from "zod";
import type { StoredSession } from "../../../shared/session.ts";

export type PairingFailure = "invalid_code" | "too_many_attempts" | "invalid_request" | "unreachable";
export type PairingResult = { ok: true; session: StoredSession } | { ok: false; reason: PairingFailure };

/** The device token was refused: the device has been revoked. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Device token refused");
    this.name = "UnauthorizedError";
  }
}

const PAIRING_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Cleans what the user typed into a brain address: adds `http://` when no scheme is given,
 * lowercases the scheme, drops query, fragment and trailing slashes.
 * Returns null when it is not a usable http(s) URL.
 */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Takes an already-normalized server URL. */
export function webSocketUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/i, "ws")}/ws`;
}

const FAILURE_BY_STATUS: Readonly<Record<number, PairingFailure>> = {
  400: "invalid_request",
  401: "invalid_code",
  429: "too_many_attempts",
};

export async function pair(
  fetchFn: typeof fetch,
  rawServerUrl: string,
  code: string,
  deviceName: string,
): Promise<PairingResult> {
  const serverUrl = normalizeServerUrl(rawServerUrl);
  if (serverUrl === null) return { ok: false, reason: "invalid_request" };
  let payload: unknown;
  try {
    const response = await fetchFn(`${serverUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
      signal: AbortSignal.timeout(PAIRING_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: FAILURE_BY_STATUS[response.status] ?? "unreachable" };
    payload = await response.json();
  } catch {
    // Network failure, timeout, or a body that is not JSON: the brain cannot be reached properly.
    return { ok: false, reason: "unreachable" };
  }
  const parsed = PairingResponse.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "unreachable" };
  return { ok: true, session: { serverUrl, token: parsed.data.token, person: parsed.data.person } };
}

/** Authenticated HTTP calls for a paired device. */
export class BrainApi {
  readonly #fetch: typeof fetch;
  readonly #session: StoredSession;

  constructor(fetchFn: typeof fetch, session: StoredSession) {
    this.#fetch = fetchFn;
    this.#session = session;
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.#get("/conversations", z.array(ConversationSummary));
  }

  history(conversationId: string): Promise<HistoryMessage[]> {
    return this.#get(`/conversations/${encodeURIComponent(conversationId)}/messages`, z.array(HistoryMessage));
  }

  async #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    // Called as a plain function: native fetch throws "Illegal invocation" when `this` is not the global.
    const fetchFn = this.#fetch;
    const response = await fetchFn(`${this.#session.serverUrl}${path}`, {
      headers: { authorization: `Bearer ${this.#session.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) throw new Error(`Brain answered HTTP ${response.status} on ${path}`);
    return schema.parse(await response.json());
  }
}
