import { GoogleAccountSummary, GoogleOAuthClient } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import { errorBody } from "../src/server/http-errors.ts";
import { createServer } from "../src/server/server.ts";
import { createGoogleFixture, issueCode, REDIRECT, VERIFIER } from "./google-fixture.ts";
import { createChatDeps } from "./helpers.ts";

async function createContext(withGoogle = true) {
  const fixture = createGoogleFixture();
  const chat = createChatDeps(fixture.db, fixture.time.clock, new FakeEngine(() => []));
  const pairing = new PairingService(fixture.db, fixture.time.clock);
  const app = await createServer({
    pairing, repository: chat.repository, version: "0.1.0",
    chat: withGoogle ? { ...chat, google: fixture.client } : chat,
  });
  const tokenFor = async (person: string) => {
    const code = pairing.generateCode(person);
    const res = await app.inject({ method: "POST", url: "/pairing", payload: { code, deviceName: "PC" } });
    return res.json<{ token: string }>().token;
  };
  return { ...fixture, app, kevin: await tokenFor("kevin"), elodie: await tokenFor("elodie") };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const Accounts = z.array(GoogleAccountSummary);
const UNKNOWN_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

describe("/google routes", () => {
  test("401 without a valid token on every route, Google configured or not", async () => {
    for (const withGoogle of [true, false]) {
      const { app } = await createContext(withGoogle);
      for (const [method, url] of [
        ["GET", "/google/oauth-client"], ["GET", "/google/accounts"], ["POST", "/google/accounts"],
        ["DELETE", `/google/accounts/${UNKNOWN_ID}`],
      ] as const) {
        for (const headers of [{}, auth("nope")]) {
          const res = await app.inject({ method, url, headers });
          expect([res.statusCode, res.json()], `${method} ${url}`).toEqual([401, errorBody("unauthenticated")]);
        }
      }
      // Checked before the body is read: an unknown caller learns nothing from a malformed one.
      for (const body of ["{not json", JSON.stringify({ owner: "x" })]) {
        const res = await app.inject({
          method: "POST", url: "/google/accounts", headers: { ...auth("nope"), "content-type": "application/json" }, payload: body,
        });
        expect([res.statusCode, res.json()]).toEqual([401, errorBody("unauthenticated")]);
      }
      await app.close();
    }
  });

  test("503 google_unavailable on every route when Google is not configured", async () => {
    const { app, kevin } = await createContext(false);
    for (const [method, url] of [
      ["GET", "/google/oauth-client"], ["GET", "/google/accounts"], ["POST", "/google/accounts"],
      ["DELETE", `/google/accounts/${UNKNOWN_ID}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(kevin) });
      expect([res.statusCode, res.json()], `${method} ${url}`).toEqual([503, { error: "google_unavailable" }]);
    }
    await app.close();
  });

  test("the OAuth client id and scopes, never the secret", async () => {
    const { app, kevin, google } = await createContext();
    const res = await app.inject({ method: "GET", url: "/google/oauth-client", headers: auth(kevin) });
    expect(GoogleOAuthClient.parse(res.json())).toEqual({
      clientId: google.clientId,
      scopes: expect.arrayContaining(["https://www.googleapis.com/auth/gmail.compose"]) as unknown,
    });
    expect(res.body).not.toContain(google.clientSecret);
    await app.close();
  });

  test("connect, list and remove — each person sees common and their own only", async () => {
    const { app, kevin, elodie, google } = await createContext();
    const connect = (token: string, owner: string, email: string) => app.inject({
      method: "POST", url: "/google/accounts", headers: auth(token),
      payload: { owner, code: issueCode(google, email), codeVerifier: VERIFIER, redirectUri: REDIRECT },
    });
    const mine = await connect(kevin, "personal", "kevin@example.com");
    expect(mine.statusCode).toBe(201);
    expect(GoogleAccountSummary.parse(mine.json())).toMatchObject({ owner: "personal", email: "kevin@example.com", status: "connected" });
    expect(mine.body).not.toMatch(/refresh-|access-|code-/);
    expect((await connect(elodie, "common", "famille@example.com")).statusCode).toBe(201);

    const seenBy = async (token: string) =>
      Accounts.parse((await app.inject({ method: "GET", url: "/google/accounts", headers: auth(token) })).json())
        .map((a) => `${a.owner}:${a.email}`).sort();
    expect(await seenBy(kevin)).toEqual(["common:famille@example.com", "personal:kevin@example.com"]);
    expect(await seenBy(elodie)).toEqual(["common:famille@example.com"]);

    const kevinId = GoogleAccountSummary.parse(mine.json()).id;
    const stolen = await app.inject({ method: "DELETE", url: `/google/accounts/${kevinId}`, headers: auth(elodie) });
    expect([stolen.statusCode, stolen.json()]).toEqual([404, errorBody("not_found")]);
    expect(await seenBy(kevin)).toContain("personal:kevin@example.com");
    expect(google.revoked).toEqual([]);
    for (const id of ["not-a-uuid", UNKNOWN_ID]) {
      expect((await app.inject({ method: "DELETE", url: `/google/accounts/${id}`, headers: auth(kevin) })).statusCode, id).toBe(404);
    }
    expect((await app.inject({ method: "DELETE", url: `/google/accounts/${kevinId}`, headers: auth(kevin) })).statusCode).toBe(204);
    expect(google.revoked).toHaveLength(1);
    expect(await seenBy(kevin)).toEqual(["common:famille@example.com"]);
    await app.close();
  });

  test("reconnecting answers 200; refusals are explained, never with a secret", async () => {
    const { app, kevin, elodie, google } = await createContext();
    const post = (token: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/google/accounts", headers: auth(token), payload });
    const valid = (email: string) => ({ owner: "personal", code: issueCode(google, email), codeVerifier: VERIFIER, redirectUri: REDIRECT });

    expect((await post(kevin, valid("kevin@example.com"))).statusCode).toBe(201);
    expect((await post(kevin, valid("kevin@example.com"))).statusCode).toBe(200);
    const stolen = await post(elodie, valid("kevin@example.com"));
    expect([stolen.statusCode, stolen.json()]).toEqual([409, { error: "already_connected" }]);
    const partial = await post(kevin, {
      ...valid("other@example.com"), code: issueCode(google, "other@example.com", ["https://www.googleapis.com/auth/gmail.readonly"]),
    });
    expect([partial.statusCode, partial.json()]).toEqual([422, { error: "missing_scopes" }]);
    const reused = await post(kevin, { ...valid("x@example.com"), code: "used-or-unknown" });
    expect([reused.statusCode, reused.json()]).toEqual([400, { error: "exchange_failed" }]);
    google.failNext(503, "backendError");
    // The profile call after the exchange fails: Google is down.
    const down = await post(kevin, valid("y@example.com"));
    expect([down.statusCode, down.json()]).toEqual([502, { error: "google_unreachable" }]);
    for (const bad of [
      { ...valid("x@example.com"), owner: "elodie" },
      { ...valid("x@example.com"), redirectUri: "https://evil.example/callback" },
      { ...valid("x@example.com"), personId: "elodie" },
      { ...valid("x@example.com"), codeVerifier: "short" },
    ]) {
      const res = await post(kevin, bad);
      expect([res.statusCode, res.json()], JSON.stringify(bad)).toEqual([400, errorBody("invalid_request")]);
      expect(res.body).not.toContain(bad.code);
    }
    await app.close();
  });
});
