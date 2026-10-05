import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FakeGoogle } from "../src/google/fake-google.ts";
import { fetchProfileEmail, GoogleAuthError, GoogleOAuth } from "../src/google/oauth.ts";
import { createTestClock } from "./helpers.ts";

const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "http://127.0.0.1:53682";

function setup() {
  const google = new FakeGoogle();
  const time = createTestClock();
  const oauth = new GoogleOAuth({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch, time.clock);
  return { google, time, oauth };
}

/** The error `promise` rejects with (fails the test when it resolves, or rejects with something else). */
async function rejection(promise: Promise<unknown>): Promise<GoogleAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleAuthError) return error;
    throw error;
  }
  throw new Error("expected a GoogleAuthError");
}

async function failure(promise: Promise<unknown>): Promise<string> {
  return (await rejection(promise)).failure;
}

describe("Google OAuth", () => {
  test("exchanges a code with its PKCE verifier", async () => {
    const { google, time, oauth } = setup();
    const code = google.issueCode("kevin@example.com", { challenge: CHALLENGE });
    const tokens = await oauth.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.expiresAt).toBe(time.clock() + 3_599_000);
    expect(tokens.scopes).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(await fetchProfileEmail(google.fetch, tokens.accessToken)).toBe("kevin@example.com");
    const sent = google.requests[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url.href).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(sent?.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe("alicia-test-secret");
    expect(form.get("code_verifier")).toBe(VERIFIER);
    expect(form.get("redirect_uri")).toBe(REDIRECT);
  });

  test("a wrong verifier, a reused code or a bad client: refused", async () => {
    const { google, oauth } = setup();
    const code = google.issueCode("kevin@example.com", { challenge: CHALLENGE });
    expect(await failure(oauth.exchangeCode({ code, codeVerifier: "w".repeat(43), redirectUri: REDIRECT }))).toBe("invalid_grant");
    expect(await failure(oauth.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT }))).toBe("invalid_grant");
    const other = new GoogleOAuth({ clientId: google.clientId, clientSecret: "wrong" }, google.fetch, () => 0);
    const code2 = google.issueCode("kevin@example.com");
    expect(await failure(other.exchangeCode({ code: code2, codeVerifier: VERIFIER, redirectUri: REDIRECT }))).toBe("rejected");
  });

  test("a redirect that is not the loopback is refused", async () => {
    const { google, oauth } = setup();
    const code = google.issueCode("kevin@example.com", { challenge: CHALLENGE });
    expect(await failure(oauth.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: "http://evil.example" }))).toBe("rejected");
  });

  test("refresh, then invalid_grant once the grant is revoked", async () => {
    const { google, oauth } = setup();
    const tokens = await oauth.exchangeCode({ code: google.issueCode("kevin@example.com"), codeVerifier: VERIFIER, redirectUri: REDIRECT });
    const refreshToken = tokens.refreshToken ?? "";
    const refreshed = await oauth.refresh(refreshToken);
    expect(refreshed.accessToken).toMatch(/^access-/);
    expect(refreshed.refreshToken).toBeUndefined();
    google.revokeGrant("kevin@example.com");
    expect(await failure(oauth.refresh(refreshToken))).toBe("invalid_grant");
  });

  test("revocation is best effort", async () => {
    const { google, oauth } = setup();
    const tokens = await oauth.exchangeCode({ code: google.issueCode("kevin@example.com"), codeVerifier: VERIFIER, redirectUri: REDIRECT });
    const refreshToken = tokens.refreshToken ?? "";
    expect(await oauth.revoke(refreshToken)).toBe(true);
    expect(google.revoked).toEqual([refreshToken]);
    // Already revoked: Google says invalid_token, which is fine (nothing left to revoke).
    expect(await oauth.revoke(refreshToken)).toBe(false);
    const offline = new GoogleOAuth(
      { clientId: "x.apps.googleusercontent.com", clientSecret: "s" }, () => Promise.reject(new Error("offline")), () => 0,
    );
    expect(await offline.revoke("refresh-1")).toBe(false);
  });

  test("network failure, 5xx, 429 and garbage are 'unavailable'; nothing secret in the error", async () => {
    const secret = { clientId: "x.apps.googleusercontent.com", clientSecret: "GOCSPX-s" };
    const offline = new GoogleOAuth(secret, () => Promise.reject(new Error("ECONNRESET refresh-secret")), () => 0);
    const errors = [await rejection(offline.refresh("refresh-secret"))];
    for (const response of [
      new Response("oops refresh-secret", { status: 503 }),
      new Response("{}", { status: 429 }),
      new Response("not json", { status: 200 }),
      new Response(JSON.stringify({ access_token: "" }), { status: 200 }),
    ]) {
      const down = new GoogleOAuth(secret, () => Promise.resolve(response), () => 0);
      errors.push(await rejection(down.refresh("refresh-secret")));
    }
    for (const error of errors) {
      expect(error.failure).toBe("unavailable");
      expect(`${error.message} ${String(error.cause)}`).not.toMatch(/refresh-secret|GOCSPX/);
    }
  });

  test("the profile address: lowercased, validated", async () => {
    const ok = () => Promise.resolve(new Response(JSON.stringify({ emailAddress: "Kevin@Example.com" })));
    expect(await fetchProfileEmail(ok, "t")).toBe("kevin@example.com");
    const garbage = () => Promise.resolve(new Response(JSON.stringify({ emailAddress: "not an address" })));
    expect(await failure(fetchProfileEmail(garbage, "t"))).toBe("unavailable");
    const refused = () => Promise.resolve(new Response("{}", { status: 403 }));
    expect(await failure(fetchProfileEmail(refused, "t"))).toBe("rejected");
  });
});
