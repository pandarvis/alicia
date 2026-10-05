import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { GoogleClient } from "../src/google/google-client.ts";
import { type ApiRequest, GoogleApiError } from "../src/google/http.ts";
import { GoogleOAuth } from "../src/google/oauth.ts";
import { TokenCipher } from "../src/google/token-cipher.ts";
import { GoogleAccountStore } from "../src/google/account-store.ts";
import { createFamilyGoogle, createGoogleFixture, issueCode, REDIRECT, VERIFIER } from "./google-fixture.ts";
import { createTestGoogleAccounts, ELODIE, KEVIN } from "./helpers.ts";

const PROFILE = { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" } as const;
const Profile = z.object({ emailAddress: z.string() });

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleApiError) return error.failure;
    throw error;
  }
  return "none";
}

describe("GoogleClient", () => {
  test("connect stores the account and reuses the fresh access token", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "common", "famille@example.com");
    expect(client.list(ELODIE).map((a) => a.email)).toEqual(["famille@example.com"]);
    const before = google.requests.length;
    expect(await client.forPerson(ELODIE).json(account, PROFILE, Profile)).toEqual({ emailAddress: "famille@example.com" });
    expect(google.requests.slice(before).map((r) => r.url.pathname)).toEqual(["/gmail/v1/users/me/profile"]);
  });

  test("missing scopes, a bad code, someone else's address: nothing stored", async () => {
    const { client, google, connect } = createGoogleFixture();
    const partial = issueCode(google, "kevin@example.com", ["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(await client.connect(KEVIN, { owner: "personal", code: partial, codeVerifier: VERIFIER, redirectUri: REDIRECT }))
      .toEqual({ status: "missing_scopes" });
    expect(await client.connect(KEVIN, { owner: "personal", code: "nope", codeVerifier: VERIFIER, redirectUri: REDIRECT }))
      .toEqual({ status: "exchange_failed" });
    expect(client.list(KEVIN)).toEqual([]);
    await connect(KEVIN, "personal", "kevin@example.com");
    const code = issueCode(google, "kevin@example.com");
    expect(await client.connect(ELODIE, { owner: "personal", code, codeVerifier: VERIFIER, redirectUri: REDIRECT }))
      .toEqual({ status: "conflict" });
    expect(client.list(ELODIE)).toEqual([]);
  });

  test("Google refusing the new account's profile: the exchange failed; Google down: unavailable", async () => {
    const { client, google } = createGoogleFixture();
    for (const [status, expected] of [[403, "exchange_failed"], [401, "exchange_failed"], [503, "unavailable"]] as const) {
      google.failNext(status, "nope");
      const code = issueCode(google, "kevin@example.com");
      expect(await client.connect(KEVIN, { owner: "personal", code, codeVerifier: VERIFIER, redirectUri: REDIRECT }), String(status))
        .toEqual({ status: expected });
    }
    expect(client.list(KEVIN)).toEqual([]);
  });

  test("an account removed while its token was being refreshed: the call stops, Google is not called with it", async () => {
    const { db, time, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    let release: () => void = () => undefined;
    let asked = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The refresh answer is held until the account is gone.
    const slowToken: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/token")) {
        asked = true;
        await held;
      }
      return google.fetch(input, init);
    };
    const oauth = new GoogleOAuth({ clientId: google.clientId, clientSecret: google.clientSecret }, slowToken, time.clock);
    const client = new GoogleClient({
      accounts: createTestGoogleAccounts(db, time.clock), oauth, fetch: google.fetch, clock: time.clock, clientId: google.clientId,
    });
    const pending = failureOf(client.forPerson(KEVIN).json(account, PROFILE, Profile));
    await vi.waitFor(() => {
      expect(asked).toBe(true);
    });
    createTestGoogleAccounts(db, time.clock).remove(KEVIN.id, account.id);
    const before = google.requests.length;
    release();
    expect(await pending).toBe("not_found");
    expect(google.requests.slice(before).map((r) => r.url.pathname)).toEqual(["/token"]);
  });

  test("the reconnect notice names the account as stored, whatever object the tool held", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    google.revokeGrant("kevin@example.com");
    google.expireAccessTokens();
    const access = client.forPerson(KEVIN);
    expect(await failureOf(access.json({ ...account, email: "spoof@example.com" }, PROFILE, Profile))).toBe("reconnect");
    expect(access.flagged()).toEqual([{ id: account.id, email: "kevin@example.com" }]);
  });

  test("an expired access token is refreshed once, transparently", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    google.expireAccessTokens();
    expect(await client.forPerson(KEVIN).json(account, PROFILE, Profile)).toEqual({ emailAddress: "kevin@example.com" });
    expect(google.requests.filter((r) => r.url.pathname === "/token").length).toBe(2);
  });

  test("a revoked grant flags the account and stops calling Google for it", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    google.revokeGrant("kevin@example.com");
    google.expireAccessTokens();
    const access = client.forPerson(KEVIN);
    expect(await failureOf(access.json(account, PROFILE, Profile))).toBe("reconnect");
    expect(client.list(KEVIN)[0]?.status).toBe("reconnect");
    expect(access.flagged()).toEqual([{ id: account.id, email: "kevin@example.com" }]);
    const before = google.requests.length;
    expect(await failureOf(access.json(account, PROFILE, Profile))).toBe("reconnect");
    expect(google.requests.length).toBe(before);
  });

  test("cloisonnement: Élodie's access cannot use Kévin's account, even holding its object", async () => {
    const { client, google, accounts } = await createFamilyGoogle();
    const before = google.requests.length;
    expect(await failureOf(client.forPerson(ELODIE).json(accounts.kevin, PROFILE, Profile))).toBe("not_found");
    expect(await failureOf(client.send(ELODIE.id, accounts.kevin.id, PROFILE))).toBe("not_found");
    expect(google.requests.slice(before)).toEqual([]);
    expect(client.forPerson(ELODIE).account("kevin@example.com")).toBeUndefined();
    expect(client.forPerson(ELODIE).accounts().map((a) => a.email).sort()).toEqual(["elodie@example.com", "famille@example.com"]);
  });

  test("cloisonnement: Élodie tries every parameter to reach Kévin's account; Google never hears of it", async () => {
    const { client, google, accounts } = await createFamilyGoogle();
    const before = google.requests.length;
    const access = client.forPerson(ELODIE);
    const disguised = [accounts.kevin, { ...accounts.kevin, owner: "elodie" }, { ...accounts.kevin, owner: "common" }];
    for (const account of disguised) {
      expect(await failureOf(access.json(account, PROFILE, Profile)), account.owner).toBe("not_found");
      expect(await failureOf(access.empty(account, PROFILE)), account.owner).toBe("not_found");
    }
    for (const personId of ["elodie", "common", "", "%"]) {
      expect(await failureOf(client.send(personId, accounts.kevin.id, PROFILE)), personId).toBe("not_found");
    }
    for (const email of ["kevin@example.com", " KEVIN@Example.com ", "%"]) {
      expect(access.account(email), email).toBeUndefined();
    }
    expect(access.flagged()).toEqual([]);
    expect(google.requests.slice(before)).toEqual([]);
    expect(client.list(KEVIN).find((a) => a.id === accounts.kevin.id)?.status).toBe("connected");
  });

  test("Élodie's turn cannot flag Kévin's account for reconnection", async () => {
    const { client, google, accounts } = await createFamilyGoogle();
    google.revokeGrant("kevin@example.com");
    google.expireAccessTokens();
    expect(await failureOf(client.forPerson(ELODIE).json(accounts.kevin, PROFILE, Profile))).toBe("not_found");
    expect(client.list(KEVIN).find((a) => a.id === accounts.kevin.id)?.status).toBe("connected");
  });

  test("two calls needing a new token at once share one refresh", async () => {
    const { client, google, connect, time } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    // The cached token is past its expiry: both calls need a new one before calling Google.
    time.advance(3_600_000);
    const access = client.forPerson(KEVIN);
    const before = google.requests.filter((r) => r.url.pathname === "/token").length;
    await Promise.all([access.json(account, PROFILE, Profile), access.json(account, PROFILE, Profile)]);
    expect(google.requests.filter((r) => r.url.pathname === "/token").length).toBe(before + 1);
  });

  test("the turn's signal: once it aborts, Google is not called and nothing is flagged", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    const turn = new AbortController();
    const access = client.forPerson(KEVIN, turn.signal);
    expect(await access.json(account, PROFILE, Profile)).toEqual({ emailAddress: "kevin@example.com" });
    turn.abort();
    const before = google.requests.length;
    expect(await failureOf(access.json(account, PROFILE, Profile))).toBe("unavailable");
    expect(google.requests.length).toBe(before);
    expect(access.flagged()).toEqual([]);
    expect(client.list(KEVIN)[0]?.status).toBe("connected");
  });

  test("the turn ends while Google is answering: the call stops at once, 'unavailable', nothing flagged", async () => {
    const { db, time, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    let reached = false;
    // Google receives the call and never answers: only the abort can end it.
    const hanging: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/token")) return google.fetch(input, init);
      reached = true;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    };
    const oauth = new GoogleOAuth({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch, time.clock);
    const client = new GoogleClient({
      accounts: createTestGoogleAccounts(db, time.clock), oauth, fetch: hanging, clock: time.clock, clientId: google.clientId,
    });
    const turn = new AbortController();
    const access = client.forPerson(KEVIN, turn.signal);
    const pending = failureOf(access.json(account, PROFILE, Profile));
    await vi.waitFor(() => {
      expect(reached).toBe(true);
    });
    turn.abort();
    expect(await pending).toBe("unavailable");
    expect(access.flagged()).toEqual([]);
    expect(client.list(KEVIN)[0]?.status).toBe("connected");
  });

  test("errors carry no token, code or Google message", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    google.failNext(400, "Invalid value for kevin's secret plans");
    let message = "";
    try {
      await client.forPerson(KEVIN).json(account, PROFILE, Profile);
    } catch (error) {
      message = error instanceof Error ? `${error.message} ${String(error.cause)}` : "";
    }
    expect(message).toMatch(/invalid/);
    expect(message).not.toMatch(/secret plans|access-|refresh-/);
  });

  test("extra headers pass, but never replace the account's own authorization", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    const request = { ...PROFILE, headers: { authorization: "Bearer someone-else", "if-match": "\"etag-1\"" } };
    expect(await client.forPerson(KEVIN).json(account, request, Profile)).toEqual({ emailAddress: "kevin@example.com" });
    expect(google.requests.at(-1)?.email).toBe("kevin@example.com");
  });

  test("Google's answers map to failures", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    const access = client.forPerson(KEVIN);
    for (const [status, reason, expected] of [
      [404, "notFound", "not_found"], [429, "rateLimitExceeded", "unavailable"], [403, "rateLimitExceeded", "unavailable"],
      [403, "forbidden", "forbidden"], [500, "backendError", "unavailable"], [400, "invalid", "invalid"],
      [410, "deleted", "not_found"], [412, "conditionNotMet", "changed"], [403, "dailyLimitExceeded", "unavailable"],
    ] as const) {
      google.failNext(status, reason);
      expect(await failureOf(access.json(account, PROFILE, Profile))).toBe(expected);
    }
    google.failNext(403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    expect(await failureOf(access.json(account, PROFILE, Profile))).toBe("reconnect");
  });

  test("an answer that does not match the schema is 'unavailable', never trusted", async () => {
    const { client, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    expect(await failureOf(client.forPerson(KEVIN).json(account, PROFILE, z.object({ id: z.number() })))).toBe("unavailable");
  });

  test("a changed ALICIA_SECRET_KEY turns accounts into 'reconnect' instead of crashing", async () => {
    const { db, time, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    const otherKey = new GoogleAccountStore(db, new TokenCipher(Buffer.alloc(32, 1)), time.clock);
    const oauth = new GoogleOAuth({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch, time.clock);
    const restarted = new GoogleClient({ accounts: otherKey, oauth, fetch: google.fetch, clock: time.clock, clientId: google.clientId });
    expect(await failureOf(restarted.forPerson(KEVIN).json(account, PROFILE, Profile))).toBe("reconnect");
    expect(restarted.list(KEVIN)[0]?.status).toBe("reconnect");
  });

  test("remove revokes the token; out of reach it does nothing", async () => {
    const { client, google, accounts } = await createFamilyGoogle();
    expect(await client.remove(ELODIE, accounts.kevin.id)).toBe(false);
    expect(google.revoked).toEqual([]);
    expect(await client.remove(KEVIN, accounts.kevin.id)).toBe(true);
    expect(google.revoked).toHaveLength(1);
    expect(client.list(KEVIN).map((a) => a.email)).toEqual(["famille@example.com"]);
  });
});

describe("what may reach Google", () => {
  const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

  test("Gmail: only reading the profile, searching, reading a message and creating a draft — checked before any call", async () => {
    const { client, google, connect } = createGoogleFixture();
    const account = await connect(KEVIN, "personal", "kevin@example.com");
    const access = client.forPerson(KEVIN);
    const before = google.requests.length;
    const refused: ApiRequest[] = [
      { method: "POST", url: `${GMAIL}/messages/send` },
      { method: "POST", url: `${GMAIL}/drafts/send` },
      { method: "POST", url: `${GMAIL}/drafts/d1/send` },
      { method: "POST", url: `${GMAIL}/messages` },
      { method: "POST", url: `${GMAIL}/messages/m1/modify` },
      { method: "DELETE", url: `${GMAIL}/messages/m1` },
      { method: "POST", url: `${GMAIL}/messages/m1/trash` },
      { method: "GET", url: `${GMAIL}/messages/m1/attachments/a1` },
      { method: "GET", url: `${GMAIL}/drafts` },
      { method: "PATCH", url: `${GMAIL}/drafts` },
      { method: "POST", url: `${GMAIL}/settings/forwardingAddresses` },
      { method: "GET", url: `${GMAIL}/messages/%2e%2e/settings/filters` },
      { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/other%40example.com/profile" },
      { method: "POST", url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send" },
      { method: "GET", url: "http://gmail.googleapis.com/gmail/v1/users/me/profile" },
      { method: "GET", url: "https://gmail.googleapis.com:8443/gmail/v1/users/me/profile" },
      { method: "GET", url: "https://evil.example/gmail/v1/users/me/profile" },
      { method: "GET", url: "https://www.googleapis.com/drive/v3/files" },
    ];
    for (const request of refused) {
      expect(await failureOf(access.json(account, request, z.unknown())), `${request.method} ${request.url}`).toBe("invalid");
    }
    expect(google.requests.length).toBe(before);
    for (const request of [
      { method: "GET", url: `${GMAIL}/profile` },
      { method: "GET", url: `${GMAIL}/messages`, query: { q: "is:unread" } },
      { method: "GET", url: `${GMAIL}/messages/m%2F1` },
      { method: "POST", url: `${GMAIL}/drafts`, body: { message: { raw: "eA" } } },
    ] satisfies ApiRequest[]) {
      expect(await failureOf(access.json(account, request, z.unknown())), `${request.method} ${request.url}`).not.toBe("invalid");
    }
  });

  test("no string in the Google code names a way to send", () => {
    const root = fileURLToPath(new URL("../src/google", import.meta.url));
    const found: string[] = [];
    for (const file of readdirSync(root).filter((name) => name.endsWith(".ts"))) {
      const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest);
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node))
          && /\bsend\b/i.test(node.text)) {
          found.push(`${file}: ${node.text}`);
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    expect(found).toEqual([]);
  });
});
