import { GOOGLE_SCOPES, type GoogleConnectRequest, type Person } from "@alicia/protocol";
import type { z } from "zod";
import type { Clock } from "../clock.ts";
import type { ToolScope } from "../tools/catalog.ts";
import type { ConnectResult, GoogleAccount, GoogleAccountStore } from "./account-store.ts";
import { type ApiRequest, buildUrl, failureOf, GoogleApiError, type GoogleRequester, isAllowedRoute } from "./http.ts";
import { fetchProfileEmail, GoogleAuthError, type GoogleOAuth, type Tokens } from "./oauth.ts";
import { TokenDecryptError } from "./token-cipher.ts";

const TIMEOUT_MS = 20_000;
/** An access token is renewed this long before Google's expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export type ConnectOutcome = ConnectResult | { status: "exchange_failed" | "missing_scopes" | "unavailable" };

export interface GoogleClientDependencies {
  accounts: GoogleAccountStore;
  oauth: GoogleOAuth;
  /** Google's HTTP: the global fetch in production, FakeGoogle's in tests. */
  fetch: typeof fetch;
  clock: Clock;
  /** Public id of the desktop OAuth client (handed to the app to start the browser flow). */
  clientId: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface ReconnectNotice {
  id: string;
  email: string;
}

/** Google for the whole brain: connects and removes accounts, keeps access tokens in memory only. */
export class GoogleClient {
  readonly clientId: string;
  readonly #deps: GoogleClientDependencies;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #refreshing = new Map<string, Promise<string>>();
  /** Per conversation: the accounts its current turn found needing a reconnection. */
  readonly #turns = new Map<string, Map<string, ReconnectNotice>>();

  constructor(deps: GoogleClientDependencies) {
    this.clientId = deps.clientId;
    this.#deps = deps;
  }

  list(person: Person): GoogleAccount[] {
    return this.#deps.accounts.list(person.id);
  }

  /** Exchanges the code the app obtained, checks the scopes, finds the address, stores the account. */
  async connect(person: Person, request: GoogleConnectRequest): Promise<ConnectOutcome> {
    let tokens: Tokens;
    try {
      tokens = await this.#deps.oauth.exchangeCode(request);
    } catch (error) {
      if (error instanceof GoogleAuthError) return { status: error.failure === "unavailable" ? "unavailable" : "exchange_failed" };
      throw error;
    }
    const refreshToken = tokens.refreshToken;
    if (refreshToken === undefined) return { status: "exchange_failed" };
    if (GOOGLE_SCOPES.some((scope) => !tokens.scopes.includes(scope))) return { status: "missing_scopes" };
    let email: string;
    try {
      email = await fetchProfileEmail(this.#deps.fetch, tokens.accessToken);
    } catch (error) {
      // Google refusing the fresh token on the profile means the exchange did not give what was asked.
      if (error instanceof GoogleAuthError) return { status: error.failure === "unavailable" ? "unavailable" : "exchange_failed" };
      throw error;
    }
    const result = this.#deps.accounts.connect({
      personId: person.id, owner: request.owner, email, scopes: tokens.scopes, refreshToken,
    });
    if (result.status !== "conflict") {
      this.#tokens.set(result.account.id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    }
    return result;
  }

  /** Removes an account within the person's reach and revokes its token (best effort). */
  async remove(person: Person, id: string): Promise<boolean> {
    const removed = this.#deps.accounts.remove(person.id, id);
    if (removed === undefined) return false;
    this.#tokens.delete(id);
    if (removed.refreshToken !== undefined) await this.#deps.oauth.revoke(removed.refreshToken);
    return true;
  }

  /**
   * What Alicia may do with Google during one turn, for the person speaking. `signal`: the turn's own; once it
   * aborts, no call of this access reaches Google any more.
   */
  forPerson(person: Person, signal?: AbortSignal): GoogleAccess {
    return new GoogleAccess(this, person, signal);
  }

  /**
   * Google for one turn (its tools share it). What it finds needing a reconnection is kept under the conversation
   * until `endTurn`, for the chat's « Reconnecter » card — and only that: building the tools without a turn (the
   * startup name check) or a turn that finds nothing leaves nothing behind. One turn at a time per conversation
   * (the server's locks).
   */
  forTurn(scope: Pick<ToolScope, "person" | "conversationId" | "signal">): GoogleAccess {
    const { conversationId, signal } = scope;
    return new GoogleAccess(this, scope.person, signal, (notice) => {
      // Found once the turn is over: nobody will collect it, so it is not kept.
      if (signal.aborted) return;
      const held = this.#turns.get(conversationId) ?? new Map<string, ReconnectNotice>();
      held.set(notice.id, notice);
      this.#turns.set(conversationId, held);
    });
  }

  /** Accounts found needing a reconnection during the conversation's turn; forgets them. */
  endTurn(conversationId: string): ReconnectNotice[] {
    const held = this.#turns.get(conversationId);
    this.#turns.delete(conversationId);
    return [...(held?.values() ?? [])];
  }

  /** Turns whose findings wait for `endTurn` (none once every turn has ended). */
  get turnsHeld(): number {
    return this.#turns.size;
  }

  /** One authorized call. The person's reach is checked on every call, cached token or not. */
  async send(personId: string, accountId: string, request: ApiRequest, signal?: AbortSignal): Promise<Response> {
    // A route Alicia has no business with (sending a mail, another host…) never gets a token, nor a call.
    if (!isAllowedRoute(request)) throw new GoogleApiError("invalid");
    const account = this.#deps.accounts.get(personId, accountId);
    if (account === undefined) throw new GoogleApiError("not_found");
    if (account.status === "reconnect") throw new GoogleApiError("reconnect");
    // The turn is over: neither a token refresh nor a call is made for it.
    if (signal?.aborted === true) throw new GoogleApiError("unavailable");
    let response = await this.#call(await this.#accessToken(personId, accountId, false), request, signal);
    if (response.status === 401) {
      // The refused answer is dropped before trying again (its connection is released).
      await response.body?.cancel().catch(() => undefined);
      response = await this.#call(await this.#accessToken(personId, accountId, true), request, signal);
    }
    if (response.ok) return response;
    const failure = failureOf(response.status, await response.text().catch(() => ""));
    if (failure === "reconnect") this.#flagReconnect(personId, accountId);
    throw new GoogleApiError(failure);
  }

  async #call(token: string, request: ApiRequest, signal: AbortSignal | undefined): Promise<Response> {
    const fetchFn = this.#deps.fetch;
    const json = request.body !== undefined;
    try {
      return await fetchFn(buildUrl(request), {
        method: request.method,
        // The token last: no extra header can replace it.
        headers: { ...request.headers, ...(json ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
        ...(json ? { body: JSON.stringify(request.body) } : {}),
        signal: signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
      });
    } catch {
      // Network failure, timeout or the turn ended: never a reason to reconnect.
      throw new GoogleApiError("unavailable");
    }
  }

  #accessToken(personId: string, accountId: string, force: boolean): Promise<string> {
    const cached = this.#tokens.get(accountId);
    if (!force && cached !== undefined && cached.expiresAt - EXPIRY_MARGIN_MS > this.#deps.clock()) {
      return Promise.resolve(cached.token);
    }
    // Two tools of the same turn may need a token at once: a single refresh serves both.
    const pending = this.#refreshing.get(accountId);
    if (pending !== undefined) return pending;
    const refresh = this.#refresh(personId, accountId).finally(() => {
      this.#refreshing.delete(accountId);
    });
    this.#refreshing.set(accountId, refresh);
    return refresh;
  }

  async #refresh(personId: string, accountId: string): Promise<string> {
    let refreshToken: string | undefined;
    try {
      refreshToken = this.#deps.accounts.refreshTokenOf(personId, accountId);
    } catch (error) {
      if (!(error instanceof TokenDecryptError)) throw error;
      this.#flagReconnect(personId, accountId);
      throw new GoogleApiError("reconnect");
    }
    if (refreshToken === undefined) throw new GoogleApiError("not_found");
    try {
      const tokens = await this.#deps.oauth.refresh(refreshToken);
      // Removed (or out of reach) while Google answered: its token is neither kept nor used.
      if (this.#deps.accounts.get(personId, accountId) === undefined) throw new GoogleApiError("not_found");
      this.#tokens.set(accountId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof GoogleApiError) throw error;
      if (!(error instanceof GoogleAuthError)) throw error;
      if (error.failure !== "invalid_grant") {
        // invalid_client & co. are configuration problems: reconnecting would not help.
        if (error.failure === "rejected") console.error("Google refused the token refresh (check the OAuth client)");
        throw new GoogleApiError("unavailable");
      }
      this.#flagReconnect(personId, accountId);
      throw new GoogleApiError("reconnect");
    }
  }

  #flagReconnect(personId: string, accountId: string): void {
    this.#tokens.delete(accountId);
    this.#deps.accounts.markReconnect(personId, accountId);
  }
}

/**
 * Google for one person during one turn: only "common" accounts and that person's own, and a note
 * of the accounts found needing a reconnection (for the chat's « Reconnecter » card).
 */
export class GoogleAccess implements GoogleRequester {
  readonly #client: GoogleClient;
  readonly #person: Person;
  readonly #signal: AbortSignal | undefined;
  readonly #flagged = new Map<string, ReconnectNotice>();
  readonly #onReconnect: ((notice: ReconnectNotice) => void) | undefined;

  /** `onReconnect`: told of each account found needing a reconnection (the turn's card). */
  constructor(client: GoogleClient, person: Person, signal?: AbortSignal, onReconnect?: (notice: ReconnectNotice) => void) {
    this.#client = client;
    this.#person = person;
    this.#signal = signal;
    this.#onReconnect = onReconnect;
  }

  accounts(): GoogleAccount[] {
    return this.#client.list(this.#person);
  }

  /** Undefined for an unknown address or one outside this person's reach. */
  account(email: string): GoogleAccount | undefined {
    const wanted = email.trim().toLowerCase();
    return this.accounts().find((account) => account.email === wanted);
  }

  async json<T>(account: GoogleAccount, request: ApiRequest, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#send(account, request);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new GoogleApiError("unavailable");
    return parsed.data;
  }

  async empty(account: GoogleAccount, request: ApiRequest): Promise<void> {
    await this.#send(account, request);
  }

  /** Accounts that turned out to need reconnecting during this turn. */
  flagged(): ReconnectNotice[] {
    return [...this.#flagged.values()];
  }

  async #send(account: GoogleAccount, request: ApiRequest): Promise<Response> {
    try {
      return await this.#client.send(this.#person.id, account.id, request, this.#signal);
    } catch (error) {
      if (error instanceof GoogleApiError && error.failure === "reconnect") {
        // Named as stored, whatever the object the tool held says.
        const stored = this.accounts().find((a) => a.id === account.id);
        if (stored !== undefined) {
          const notice = { id: stored.id, email: stored.email };
          this.#flagged.set(stored.id, notice);
          this.#onReconnect?.(notice);
        }
      }
      throw error;
    }
  }
}
