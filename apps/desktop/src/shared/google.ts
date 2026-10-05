import { GoogleScope, LoopbackRedirectUri, PkceVerifier } from "@alicia/protocol";
import { z } from "zod";

/** What the main window may ask the main process: never a URL, only what goes into Google's consent URL. */
export const GoogleAuthorizeRequest = z.strictObject({
  clientId: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
  scopes: z.array(GoogleScope).min(1),
  /** The address to suggest in Google's account chooser (reconnecting an account). */
  loginHint: z.email().optional(),
});
export type GoogleAuthorizeRequest = z.infer<typeof GoogleAuthorizeRequest>;

/** Why there is no code: refused in the browser, no answer in time, cancelled from the app, or a local failure. */
export const GoogleAuthorizeFailure = z.enum(["denied", "timeout", "cancelled", "failed"]);
export type GoogleAuthorizeFailure = z.infer<typeof GoogleAuthorizeFailure>;

/** The code and what the brain needs to exchange it (the PKCE verifier and the exact redirect), or why not. */
export const GoogleAuthorizeResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    code: z.string().min(1).max(2048),
    codeVerifier: PkceVerifier,
    redirectUri: LoopbackRedirectUri,
  }),
  z.strictObject({ ok: z.literal(false), reason: GoogleAuthorizeFailure }),
]);
export type GoogleAuthorizeResult = z.infer<typeof GoogleAuthorizeResult>;
