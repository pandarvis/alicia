import type { GoogleAccountSummary, GoogleConnectRequest, GoogleOAuthClient, GoogleOwner } from "@alicia/protocol";
import type { GoogleAuthorizeFailure, GoogleAuthorizeRequest, GoogleAuthorizeResult } from "../../../shared/google.ts";
import type { GoogleAccountsResult, GoogleConnectFailureReason, GoogleConnectResult } from "./brain-client.ts";

/** Everything the screen needs from the outside world (fakes in tests). */
export interface AccountsPorts {
  list(): Promise<GoogleAccountsResult>;
  client(): Promise<GoogleOAuthClient>;
  /** Google's consent in the system browser (main process). */
  authorize(request: GoogleAuthorizeRequest): Promise<GoogleAuthorizeResult>;
  cancel(): Promise<void>;
  connect(input: GoogleConnectRequest): Promise<GoogleConnectResult>;
  remove(id: string): Promise<boolean>;
}

export type AccountsPhase = "loading" | "ready" | "unavailable" | "failed";
export interface AccountsMessage {
  tone: "info" | "error";
  text: string;
}
export interface ConnectingState {
  owner: GoogleOwner;
  /** The account being reconnected, or null for a new one. */
  accountId: string | null;
}

const AUTHORIZE_ERRORS: Readonly<Record<Exclude<GoogleAuthorizeFailure, "cancelled">, string>> = {
  denied: "Connexion refusée dans le navigateur.",
  timeout: "Le navigateur n'a pas répondu à temps : recommence.",
  failed: "Impossible d'ouvrir la connexion Google.",
};
const CONNECT_ERRORS: Readonly<Record<GoogleConnectFailureReason, string>> = {
  exchange_failed: "Google n'a pas validé la connexion : recommence.",
  missing_scopes: "Il faut cocher toutes les autorisations (agenda, lecture des mails, brouillons).",
  already_connected: "Ce compte Google est déjà connecté dans Alicia (en Famille ou par quelqu'un d'autre).",
  unavailable: "Google est injoignable pour l'instant : réessaie plus tard.",
};
/** When a call fails (brain unreachable or answering oddly): what could not be done, in a neutral voice. */
const FAILED = {
  load: "Impossible de charger les comptes pour l'instant.",
  connect: "La connexion n'a pas abouti : réessaie.",
  remove: "Impossible de retirer ce compte pour l'instant.",
} as const;

const byEmail = (a: GoogleAccountSummary, b: GoogleAccountSummary): number => a.email.localeCompare(b.email);

/** State of the Comptes screen: the Google accounts the person reaches, and adding, reconnecting, removing them. */
export class AccountsScreen {
  phase = $state<AccountsPhase>("loading");
  accounts = $state<GoogleAccountSummary[]>([]);
  connecting = $state<ConnectingState | null>(null);
  message = $state<AccountsMessage | null>(null);
  /** The account whose removal is being asked (inline Oui / Non). */
  removingId = $state<string | null>(null);
  removing = $state(false);

  readonly common = $derived(this.accounts.filter((a) => a.owner === "common").sort(byEmail));
  readonly personal = $derived(this.accounts.filter((a) => a.owner === "personal").sort(byEmail));
  /** Drives the amber dot in the menu. */
  readonly needsAttention = $derived(this.accounts.some((a) => a.status === "reconnect"));

  readonly #ports: AccountsPorts;
  /** Only the latest load is shown. */
  #loadToken = 0;

  constructor(ports: AccountsPorts) {
    this.#ports = ports;
  }

  /** Reloads; a list already shown stays on screen meanwhile. */
  async load(): Promise<void> {
    const token = ++this.#loadToken;
    try {
      const result = await this.#ports.list();
      if (token !== this.#loadToken) return;
      if (!result.available) {
        this.accounts = [];
        this.phase = "unavailable";
        return;
      }
      this.accounts = result.accounts;
      this.phase = "ready";
    } catch {
      if (token !== this.#loadToken) return;
      if (this.phase !== "ready") this.phase = "failed";
      else this.message = { tone: "error", text: FAILED.load };
    }
  }

  add(owner: GoogleOwner): Promise<void> {
    return this.#connect(owner, null, undefined);
  }

  /** Runs the flow again for an account Google stopped accepting (from this screen or a chat card). */
  async reconnect(id: string): Promise<void> {
    if (!this.accounts.some((a) => a.id === id)) await this.load();
    const account = this.accounts.find((a) => a.id === id);
    if (account === undefined) return;
    await this.#connect(account.owner, id, account.email);
  }

  /** Stops waiting for the browser (the flow then ends as cancelled, without a message). */
  cancel(): void {
    this.#ports.cancel().catch(() => undefined);
  }

  /** A screen opened again starts without the last success message (errors stay until something else happens). */
  clearInfo(): void {
    if (this.message?.tone === "info") this.message = null;
  }

  askRemove(id: string): void {
    this.message = null;
    this.removingId = id;
  }

  keep(): void {
    this.removingId = null;
  }

  async confirmRemove(): Promise<void> {
    const id = this.removingId;
    if (id === null || this.removing) return;
    this.removing = true;
    try {
      // false: already removed elsewhere — gone either way.
      await this.#ports.remove(id);
      // A list asked before the removal must not bring the account back.
      this.#loadToken++;
      this.accounts = this.accounts.filter((a) => a.id !== id);
      this.removingId = null;
      this.message = { tone: "info", text: "Compte retiré." };
    } catch {
      this.message = { tone: "error", text: FAILED.remove };
    } finally {
      this.removing = false;
    }
  }

  async #connect(owner: GoogleOwner, accountId: string | null, loginHint: string | undefined): Promise<void> {
    if (this.connecting !== null) return;
    this.connecting = { owner, accountId };
    this.message = null;
    this.removingId = null;
    try {
      const client = await this.#ports.client();
      const grant = await this.#ports.authorize({
        clientId: client.clientId, ...(loginHint !== undefined ? { loginHint } : {}),
      });
      if (!grant.ok) {
        this.message = grant.reason === "cancelled" ? null : { tone: "error", text: AUTHORIZE_ERRORS[grant.reason] };
        return;
      }
      const result = await this.#ports.connect({
        owner, code: grant.code, codeVerifier: grant.codeVerifier, redirectUri: grant.redirectUri,
      });
      if (!result.ok) {
        this.message = { tone: "error", text: CONNECT_ERRORS[result.reason] };
        return;
      }
      // A list asked before the connection must not hide the account again.
      this.#loadToken++;
      this.accounts = [...this.accounts.filter((a) => a.id !== result.account.id), result.account];
      this.phase = "ready";
      const other = accountId !== null && result.account.id !== accountId;
      this.message = {
        tone: "info",
        text: other
          ? `${result.account.email} est connecté, mais ce n'est pas le compte à reconnecter.`
          : `${result.account.email} est connecté.`,
      };
    } catch {
      this.message = { tone: "error", text: FAILED.connect };
    } finally {
      this.connecting = null;
    }
  }
}
