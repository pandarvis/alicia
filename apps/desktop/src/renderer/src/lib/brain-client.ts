import {
  ATTACHMENT_NAME_HEADER,
  type AttachmentRefusalReason,
  AttachmentSummary,
  ConversationSummary,
  GoogleAccountSummary,
  GoogleConnectFailure,
  type GoogleConnectRequest,
  GoogleOAuthClient,
  HealthResponse,
  HistoryMessage,
  HttpErrorBody,
  MemoryRefusalReason,
  type MemoryCreate,
  type MemoryKind,
  type MemoryPatch,
  type MemoryScope,
  MemorySummary,
  MemoryTestHit,
  PairingResponse,
} from "@alicia/protocol";
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

/** Result of creating or editing a memory: the memory, or why the brain did not write it. */
export type MemoryWriteResult =
  | { ok: true; memory: MemorySummary }
  | { ok: false; reason: "duplicate" | "secret" | "empty" | "not_found" | "invalid" };

/** Result of an upload: the attachment, waiting to be sent with a message, or why the brain did not take it. */
export type UploadResult =
  | { ok: true; attachment: AttachmentSummary }
  | { ok: false; reason: AttachmentRefusalReason | "failed" };

/** The Google accounts the caller reaches, or `available: false` when Google is not configured on the brain. */
export type GoogleAccountsResult = { available: true; accounts: GoogleAccountSummary[] } | { available: false };

/** Why an account was not connected, as the Comptes screen explains it. */
export type GoogleConnectFailureReason = "exchange_failed" | "missing_scopes" | "already_connected" | "unavailable";
export type GoogleConnectResult =
  | { ok: true; account: GoogleAccountSummary }
  | { ok: false; reason: GoogleConnectFailureReason };

/** The brain's word for a Google-specific failure (`{ error: "missing_scopes" }`…), distinct from its typed errors. */
const GoogleFailureBody = z.object({ error: GoogleConnectFailure });

const CONNECT_FAILURES: Readonly<Record<GoogleConnectFailure, GoogleConnectFailureReason>> = {
  exchange_failed: "exchange_failed",
  missing_scopes: "missing_scopes",
  already_connected: "already_connected",
  google_unreachable: "unavailable",
  google_unavailable: "unavailable",
};
/** Without the brain's word (a proxy page): the status. */
const CONNECT_FAILURES_BY_STATUS: Readonly<Record<number, GoogleConnectFailureReason>> = {
  400: "exchange_failed",
  409: "already_connected",
  422: "missing_scopes",
  502: "unavailable",
  503: "unavailable",
};

const PAIRING_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** 25 MB over a slow Wi-Fi or a remote connection. */
const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_REFUSALS: readonly string[] = ["too_large", "unsupported", "empty", "too_many"] satisfies AttachmentRefusalReason[];

function isUploadRefusal(code: string | undefined): code is AttachmentRefusalReason {
  return code !== undefined && UPLOAD_REFUSALS.includes(code);
}

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

const FAILURE_BY_STATUS: Readonly<Record<number, PairingFailure>> = {
  400: "invalid_request",
  401: "invalid_code",
  429: "too_many_attempts",
};

type BrainError = HttpErrorBody["error"];

/** The body as JSON, or undefined when it is empty or not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * The brain's typed error, or undefined for any other body: the flat shape of an older brain, a proxy
 * page, an empty or non-JSON body. Never throws; callers then fall back on the status.
 */
async function readError(response: Response): Promise<BrainError | undefined> {
  const parsed = HttpErrorBody.safeParse(await readJson(response));
  return parsed.success ? parsed.data.error : undefined;
}

/** The flat refusal of an older brain: { "error": "refused", "reason": "secret" }. */
const FlatRefusal = z.object({ reason: MemoryRefusalReason });

/** The typed code when it is a pairing failure, otherwise the status. */
function pairingFailure(error: BrainError | undefined, status: number): PairingFailure {
  const code = error?.code;
  if (code === "invalid_code" || code === "too_many_attempts" || code === "invalid_request") return code;
  return FAILURE_BY_STATUS[status] ?? "unreachable";
}

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
    if (!response.ok) return { ok: false, reason: pairingFailure(await readError(response), response.status) };
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

  /** The brain's version (shown in Réglages). */
  health(): Promise<HealthResponse> {
    return this.#get("/health", HealthResponse);
  }

  history(conversationId: string): Promise<HistoryMessage[]> {
    return this.#get(`/conversations/${encodeURIComponent(conversationId)}/messages`, z.array(HistoryMessage));
  }

  /** `forgotten: true` lists the trash; `false` is the same as no filter. */
  listMemories(filter: { scope?: MemoryScope; kind?: MemoryKind; q?: string; forgotten?: boolean }): Promise<MemorySummary[]> {
    const params = new URLSearchParams();
    if (filter.scope !== undefined) params.set("scope", filter.scope);
    if (filter.kind !== undefined) params.set("kind", filter.kind);
    if (filter.q !== undefined) params.set("q", filter.q);
    if (filter.forgotten === true) params.set("forgotten", "true");
    return this.#get(withQuery("/memories", params), z.array(MemorySummary));
  }

  async createMemory(input: MemoryCreate): Promise<MemoryWriteResult> {
    return this.#writeResult(await this.#request("POST", "/memories", input), "/memories", "create");
  }

  async updateMemory(id: string, patch: MemoryPatch): Promise<MemoryWriteResult> {
    const path = `/memories/${encodeURIComponent(id)}`;
    return this.#writeResult(await this.#request("PATCH", path, patch), path, "update");
  }

  /** False when the memory does not exist (or is not the caller's to forget). */
  async forgetMemory(id: string): Promise<boolean> {
    const path = `/memories/${encodeURIComponent(id)}`;
    const response = await this.#request("DELETE", path);
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw statusError(response.status, path, (await readError(response))?.code);
  }

  /** Null when there is nothing to restore (unknown, not forgotten, or forgotten too long ago). */
  async restoreMemory(id: string): Promise<MemorySummary | null> {
    const path = `/memories/${encodeURIComponent(id)}/restore`;
    const response = await this.#request("POST", path);
    if (response.status === 404) return null;
    if (!response.ok) throw statusError(response.status, path, (await readError(response))?.code);
    return MemorySummary.parse(await response.json());
  }

  /** What Alicia would find for this question, and why. */
  testMemory(q: string): Promise<MemoryTestHit[]> {
    return this.#get(withQuery("/memories/test", new URLSearchParams({ q })), z.array(MemoryTestHit));
  }

  async deleteConversation(id: string): Promise<"deleted" | "not_found" | "busy"> {
    const path = `/conversations/${encodeURIComponent(id)}`;
    const response = await this.#request("DELETE", path);
    if (response.status === 204) return "deleted";
    if (response.status === 404) return "not_found";
    if (response.status === 409) return "busy";
    throw statusError(response.status, path, (await readError(response))?.code);
  }

  /**
   * Sends a file to the brain (raw bytes, its name percent-encoded in a header); it stays pending (24 h) until a
   * message carries it. Never throws but for a revoked device: a refusal or a failure is the result.
   */
  async uploadAttachment(file: Blob, name: string): Promise<UploadResult> {
    // Called as a plain function: native fetch throws "Illegal invocation" when `this` is not the global.
    const fetchFn = this.#fetch;
    let response: Response;
    try {
      response = await fetchFn(`${this.#session.serverUrl}/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#session.token}`,
          "content-type": "application/octet-stream",
          [ATTACHMENT_NAME_HEADER]: encodeURIComponent(name),
        },
        body: file,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "failed" };
    }
    if (response.status === 401) throw new UnauthorizedError();
    if (response.status === 201) {
      const summary = AttachmentSummary.safeParse(await readJson(response));
      return summary.success ? { ok: true, attachment: summary.data } : { ok: false, reason: "failed" };
    }
    // The brain's typed error says why; anything else (proxy page, older brain) is a failure.
    const code = (await readError(response))?.code;
    return { ok: false, reason: isUploadRefusal(code) ? code : "failed" };
  }

  /** Forgets a pending upload (its chip was removed before sending); already gone is fine. */
  async discardAttachment(id: string): Promise<void> {
    const path = `/attachments/${encodeURIComponent(id)}`;
    const response = await this.#request("DELETE", path);
    if (response.status !== 204 && response.status !== 404) {
      throw statusError(response.status, path, (await readError(response))?.code);
    }
  }

  /** `available: false` only when the brain says Google is not configured on it. */
  async listGoogleAccounts(): Promise<GoogleAccountsResult> {
    const path = "/google/accounts";
    const response = await this.#request("GET", path);
    if (response.ok) return { available: true, accounts: z.array(GoogleAccountSummary).parse(await response.json()) };
    const body = await readJson(response);
    if (response.status === 503 && GoogleFailureBody.safeParse(body).data?.error === "google_unavailable") {
      return { available: false };
    }
    throw statusError(response.status, path, HttpErrorBody.safeParse(body).data?.error.code);
  }

  /** What the browser flow needs (the client secret never leaves the brain). */
  googleClient(): Promise<GoogleOAuthClient> {
    return this.#get("/google/oauth-client", GoogleOAuthClient);
  }

  /**
   * Hands the code of the browser flow to the brain, which exchanges it: the account (new or reconnected), or why
   * not. An invalid request or an unexpected answer throws.
   */
  async connectGoogleAccount(input: GoogleConnectRequest): Promise<GoogleConnectResult> {
    const path = "/google/accounts";
    const response = await this.#request("POST", path, input);
    if (response.ok) return { ok: true, account: GoogleAccountSummary.parse(await response.json()) };
    const body = await readJson(response);
    const failure = GoogleFailureBody.safeParse(body);
    if (failure.success) return { ok: false, reason: CONNECT_FAILURES[failure.data.error] };
    const typed = HttpErrorBody.safeParse(body);
    const reason = typed.success ? undefined : CONNECT_FAILURES_BY_STATUS[response.status];
    if (reason === undefined) throw statusError(response.status, path, typed.data?.error.code);
    return { ok: false, reason };
  }

  /** False when the account does not exist (or is not the caller's to remove). */
  async removeGoogleAccount(id: string): Promise<boolean> {
    const path = `/google/accounts/${encodeURIComponent(id)}`;
    const response = await this.#request("DELETE", path);
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw statusError(response.status, path, (await readError(response))?.code);
  }

  async #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#request("GET", path);
    if (!response.ok) throw statusError(response.status, path, (await readError(response))?.code);
    return schema.parse(await response.json());
  }

  /** Reads the answer of a create or update: the memory, or the reason the brain did not write it. */
  async #writeResult(response: Response, path: string, write: WriteKind): Promise<MemoryWriteResult> {
    if (response.ok) return { ok: true, memory: MemorySummary.parse(await response.json()) };
    const body = await readJson(response);
    const typed = HttpErrorBody.safeParse(body);
    if (!typed.success) return untypedWriteResult(response.status, body, path, write);
    const error = typed.data.error;
    switch (error.code) {
      case "duplicate":
        return { ok: false, reason: "duplicate" };
      case "not_found":
        return { ok: false, reason: "not_found" };
      case "invalid_request":
        return { ok: false, reason: "invalid" };
      case "refused":
        return { ok: false, reason: error.reason };
      default:
        throw statusError(response.status, path, error.code);
    }
  }

  /** One authenticated call with the request timeout; a refused token is the only status handled here. */
  async #request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Response> {
    // Called as a plain function: native fetch throws "Illegal invocation" when `this` is not the global.
    const fetchFn = this.#fetch;
    const response = await fetchFn(`${this.#session.serverUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#session.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) throw new UnauthorizedError();
    return response;
  }
}

type WriteKind = "create" | "update";

/** A write answered without the typed error body (older brain, proxy): the status decides. */
function untypedWriteResult(status: number, body: unknown, path: string, write: WriteKind): MemoryWriteResult {
  switch (status) {
    case 409:
      return { ok: false, reason: "duplicate" };
    case 404:
      // Only an update names a memory that may be gone; a 404 on a creation is a wrong address or a proxy.
      if (write === "update") return { ok: false, reason: "not_found" };
      throw statusError(status, path);
    case 400:
      return { ok: false, reason: "invalid" };
    case 422: {
      const refusal = FlatRefusal.safeParse(body);
      if (refusal.success) return { ok: false, reason: refusal.data.reason };
      throw statusError(status, path);
    }
    default:
      throw statusError(status, path);
  }
}

/** `path?params`, or just `path` when there are no params. */
function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

function statusError(status: number, path: string, code?: string): Error {
  return new Error(`Brain answered HTTP ${status}${code === undefined ? "" : ` (${code})`} on ${path}`);
}
