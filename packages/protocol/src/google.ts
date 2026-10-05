import { z } from "zod";

/**
 * The Google permissions Alicia asks for: events and the list of calendars, reading mail, writing drafts.
 * `gmail.compose` could technically send; no code path ever does (see apps/brain/src/google).
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;
export const GoogleScope = z.enum(GOOGLE_SCOPES);
export type GoogleScope = z.infer<typeof GoogleScope>;

/** Seen from the person asking: "common" is the household's (Famille), "personal" is theirs. */
export const GoogleOwner = z.enum(["common", "personal"]);
export type GoogleOwner = z.infer<typeof GoogleOwner>;

/** "reconnect": Google refused the stored authorization (revoked, expired, scope removed, key changed). */
export const GoogleAccountStatus = z.enum(["connected", "reconnect"]);
export type GoogleAccountStatus = z.infer<typeof GoogleAccountStatus>;

export const GoogleAccountSummary = z.object({
  id: z.uuid(),
  owner: GoogleOwner,
  email: z.email(),
  status: GoogleAccountStatus,
  /** Last successful connection. */
  connectedAt: z.iso.datetime(),
});
export type GoogleAccountSummary = z.infer<typeof GoogleAccountSummary>;

/** What the app needs to start the browser flow; the client secret never leaves the brain. */
export const GoogleOAuthClient = z.object({
  clientId: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
  scopes: z.array(GoogleScope).min(1),
});
export type GoogleOAuthClient = z.infer<typeof GoogleOAuthClient>;

/** Loopback redirect of a desktop OAuth flow (RFC 8252 §7.3): IPv4 literal, any port, no path. */
export const LoopbackRedirectUri = z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/);
export type LoopbackRedirectUri = z.infer<typeof LoopbackRedirectUri>;

/** PKCE verifier (RFC 7636 §4.1). */
export const PkceVerifier = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/);

export const GoogleConnectRequest = z.strictObject({
  owner: GoogleOwner,
  code: z.string().min(1).max(2048),
  codeVerifier: PkceVerifier,
  redirectUri: LoopbackRedirectUri,
});
export type GoogleConnectRequest = z.infer<typeof GoogleConnectRequest>;

/** Why the brain did not connect an account (body `{ error }` of a 4xx/5xx on POST /google/accounts). */
export const GoogleConnectFailure = z.enum([
  "exchange_failed", "missing_scopes", "already_connected", "google_unreachable", "google_unavailable",
]);
export type GoogleConnectFailure = z.infer<typeof GoogleConnectFailure>;
