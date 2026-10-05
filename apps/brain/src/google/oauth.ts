import { z } from "zod";
import type { Clock } from "../clock.ts";
import type { GoogleClientSecret } from "./client-secret.ts";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const TIMEOUT_MS = 15_000;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
});
const TokenError = z.object({ error: z.string() });
const Profile = z.object({ emailAddress: z.email() });

/** invalid_grant: the authorization is gone (revoked, expired); rejected: any other refusal. */
export type AuthFailure = "invalid_grant" | "rejected" | "unavailable";

/** Carries no token, code or secret: safe to log. */
export class GoogleAuthError extends Error {
  readonly failure: AuthFailure;

  constructor(failure: AuthFailure) {
    super(`Google OAuth failed: ${failure}`);
    this.name = "GoogleAuthError";
    this.failure = failure;
  }
}

export interface Tokens {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Only on a code exchange with access_type=offline. */
  refreshToken: string | undefined;
  scopes: string[];
}

export interface CodeExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Google's OAuth endpoints for a desktop client (secret kept by the brain). */
export class GoogleOAuth {
  readonly #secret: GoogleClientSecret;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;

  constructor(secret: GoogleClientSecret, fetchFn: typeof fetch, clock: Clock) {
    this.#secret = secret;
    this.#fetch = fetchFn;
    this.#clock = clock;
  }

  exchangeCode(exchange: CodeExchange): Promise<Tokens> {
    return this.#token({
      grant_type: "authorization_code",
      code: exchange.code,
      code_verifier: exchange.codeVerifier,
      redirect_uri: exchange.redirectUri,
    });
  }

  refresh(refreshToken: string): Promise<Tokens> {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** Best effort: true when Google confirmed. A failed revocation never blocks removing an account. */
  async revoke(token: string): Promise<boolean> {
    try {
      return (await this.#post(GOOGLE_REVOKE_URL, { token })).ok;
    } catch {
      return false;
    }
  }

  async #token(params: Readonly<Record<string, string>>): Promise<Tokens> {
    let response: Response;
    try {
      response = await this.#post(GOOGLE_TOKEN_URL, {
        ...params, client_id: this.#secret.clientId, client_secret: this.#secret.clientSecret,
      });
    } catch {
      throw new GoogleAuthError("unavailable");
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (TokenError.safeParse(payload).data?.error === "invalid_grant") throw new GoogleAuthError("invalid_grant");
      throw new GoogleAuthError(response.status >= 500 || response.status === 429 ? "unavailable" : "rejected");
    }
    const tokens = TokenResponse.safeParse(payload);
    if (!tokens.success) throw new GoogleAuthError("unavailable");
    return {
      accessToken: tokens.data.access_token,
      expiresAt: this.#clock() + tokens.data.expires_in * 1000,
      refreshToken: tokens.data.refresh_token,
      scopes: tokens.data.scope.split(" ").filter((scope) => scope !== ""),
    };
  }

  #post(url: string, params: Readonly<Record<string, string>>): Promise<Response> {
    // Called as a plain function: a fetch stored on an object must not receive it as `this`.
    const fetchFn = this.#fetch;
    return fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

/** Address of the account behind a fresh access token (Gmail profile: covered by gmail.readonly). */
export async function fetchProfileEmail(fetchFn: typeof fetch, accessToken: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(GMAIL_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GoogleAuthError("unavailable");
  }
  if (!response.ok) throw new GoogleAuthError(response.status >= 500 ? "unavailable" : "rejected");
  const profile = Profile.safeParse(await response.json().catch(() => undefined));
  if (!profile.success) throw new GoogleAuthError("unavailable");
  return profile.data.emailAddress.toLowerCase();
}
