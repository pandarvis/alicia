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

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

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
  let response: Response;
  try {
    response = await fetchFn(`${serverUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return { ok: false, reason: FAILURE_BY_STATUS[response.status] ?? "unreachable" };
  const parsed = PairingResponse.safeParse(await response.json());
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
    const response = await this.#fetch(`${this.#session.serverUrl}${path}`, {
      headers: { authorization: `Bearer ${this.#session.token}` },
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) throw new Error(`Brain answered HTTP ${response.status} on ${path}`);
    return schema.parse(await response.json());
  }
}
