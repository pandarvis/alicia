import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { GOOGLE_SCOPES } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { authorizeWithLoopback, GoogleConsent, pkcePair } from "../src/main/google-oauth.ts";
import type { GoogleAuthorizeResult } from "../src/shared/google.ts";

const REQUEST = { clientId: "123-abc.apps.googleusercontent.com" };

/** The loopback the consent URL sends the browser back to. */
function redirectOf(consentUrl: string): URL {
  return new URL(new URL(consentUrl).searchParams.get("redirect_uri") ?? "");
}

/**
 * Plays Google and the browser: reads the consent URL, then calls the loopback like the redirect would. The flow
 * may end before the browser has read the whole page: `browsed()` waits for it.
 */
function answering(params: (consent: URL) => Record<string, string>) {
  let consentUrl = "";
  const pages: { status: number; body: string; headers: Headers }[] = [];
  const visits: Promise<void>[] = [];
  const visit = async (url: string): Promise<void> => {
    consentUrl = url;
    const consent = new URL(url);
    const back = redirectOf(url);
    for (const [name, value] of Object.entries(params(consent))) back.searchParams.set(name, value);
    const response = await fetch(back);
    pages.push({ status: response.status, body: await response.text(), headers: response.headers });
  };
  const open = (url: string): Promise<void> => {
    const visiting = visit(url);
    visits.push(visiting);
    return visiting;
  };
  const browsed = async (): Promise<void> => {
    await Promise.all(visits);
  };
  return { open, pages, browsed, consent: () => new URL(consentUrl) };
}

const stateOf = (consent: URL): string => consent.searchParams.get("state") ?? "";

/** A raw request with any method, path and Host header (fetch would not let the test forge the Host). */
function rawRequest(base: URL, options: { method?: string; path?: string; host?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: base.hostname,
      port: base.port,
      method: options.method ?? "GET",
      path: options.path ?? "/",
      headers: { host: options.host ?? base.host, connection: "close" },
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("loopback authorization", () => {
  test("PKCE pair: a 43-character verifier and its S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  test("returns the code, the verifier and the loopback redirect", async () => {
    const google = answering((consent) => ({ code: "4/0Acode", state: stateOf(consent) }));
    const result = await authorizeWithLoopback({ ...REQUEST, loginHint: "famille@example.com" }, { open: google.open });
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
    const consent = google.consent();
    expect(`${consent.origin}${consent.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(result.code).toBe("4/0Acode");
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(consent.searchParams.get("client_id")).toBe(REQUEST.clientId);
    expect(consent.searchParams.get("response_type")).toBe("code");
    expect(consent.searchParams.get("redirect_uri")).toBe(result.redirectUri);
    expect(consent.searchParams.get("code_challenge")).toBe(createHash("sha256").update(result.codeVerifier).digest("base64url"));
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("access_type")).toBe("offline");
    expect(consent.searchParams.get("prompt")).toBe("consent");
    expect(consent.searchParams.get("login_hint")).toBe("famille@example.com");
    expect(consent.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_SCOPES]);
    expect(stateOf(consent)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier itself never goes to Google's page (only its challenge does).
    expect(consent.href).not.toContain(result.codeVerifier);

    await google.browsed();

    const page = google.pages[0];
    expect(page?.status).toBe(200);
    expect(page?.body).toContain("C'est fait");
    // Nothing runs, nothing loads, the URL (with the code) is never sent anywhere.
    expect(page?.headers.get("content-security-policy")).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(page?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page?.headers.get("cache-control")).toBe("no-store");
    expect(page?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page?.body).not.toContain("4/0Acode");
    // The loopback is closed once the flow is over, whatever the request.
    await expect(fetch(result.redirectUri)).rejects.toThrow();
    await expect(rawRequest(new URL(result.redirectUri), { host: "evil.example:80" })).rejects.toThrow();
  });

  test("the style block matches the hash the page allows", async () => {
    const google = answering((consent) => ({ code: "4/0Acode", state: stateOf(consent) }));
    await authorizeWithLoopback(REQUEST, { open: google.open });
    await google.browsed();
    const page = google.pages[0];
    const css = /<style>(.*)<\/style>/.exec(page?.body ?? "")?.[1] ?? "";
    const hash = createHash("sha256").update(css).digest("base64");
    expect(page?.headers.get("content-security-policy")).toContain(`'sha256-${hash}'`);
  });

  test("a wrong state is refused and does not end the flow", async () => {
    let attempt = 0;
    const google = answering((consent) => {
      attempt += 1;
      return { code: "4/0Acode", state: attempt === 1 ? "forged" : stateOf(consent) };
    });
    const result = await authorizeWithLoopback(REQUEST, {
      open: async (url) => {
        await google.open(url);
        await google.open(url);
      },
    });
    await google.browsed();
    expect(google.pages[0]?.status).toBe(400);
    expect(google.pages[0]?.body).toContain("ne vient pas d'Alicia");
    expect(result.ok).toBe(true);
  });

  test("a repeated state, another path, another method or another host is not heard", async () => {
    const statuses: number[] = [];
    let page = "";
    let browsing: Promise<void> = Promise.resolve();
    const browse = async (url: string): Promise<void> => {
      const back = redirectOf(url);
      const state = stateOf(new URL(url));
      const good = `/?code=4%2F0Acode&state=${encodeURIComponent(state)}`;
      statuses.push(await rawRequest(back, { path: `/favicon.ico?code=x&state=${encodeURIComponent(state)}` }));
      statuses.push(await rawRequest(back, { method: "POST", path: good }));
      statuses.push(await rawRequest(back, { path: good, host: "evil.example:80" }));
      statuses.push(await rawRequest(back, { path: `${good}&state=${encodeURIComponent(state)}` }));
      const response = await fetch(new URL(good, back));
      page = await response.text();
    };
    const result = await authorizeWithLoopback(REQUEST, {
      open: (url) => {
        browsing = browse(url);
        return browsing;
      },
    });
    await browsing;
    expect(statuses).toEqual([404, 404, 404, 400]);
    expect(page).toContain("C'est fait");
    expect(result).toMatchObject({ ok: true, code: "4/0Acode" });
  });

  test("a refusal in the browser, a timeout and a cancellation", async () => {
    const denied = answering((consent) => ({ error: "access_denied", state: stateOf(consent) }));
    expect(await authorizeWithLoopback(REQUEST, { open: denied.open })).toEqual({ ok: false, reason: "denied" });
    await denied.browsed();
    expect(denied.pages[0]?.body).toContain("Annulé");

    expect(await authorizeWithLoopback(REQUEST, { open: () => Promise.resolve(), timeoutMs: 50 }))
      .toEqual({ ok: false, reason: "timeout" });

    const controller = new AbortController();
    let redirect = "";
    const flow = authorizeWithLoopback(REQUEST, {
      open: (url) => {
        redirect = redirectOf(url).href;
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(await flow).toEqual({ ok: false, reason: "cancelled" });
    // Cancelled: nobody listens any more.
    await expect(fetch(redirect)).rejects.toThrow();

    const already = new AbortController();
    already.abort();
    let opened = false;
    expect(await authorizeWithLoopback(REQUEST, {
      open: () => {
        opened = true;
        return Promise.resolve();
      },
      signal: already.signal,
    })).toEqual({ ok: false, reason: "cancelled" });
    expect(opened).toBe(false);

    expect(await authorizeWithLoopback(REQUEST, { open: () => Promise.reject(new Error("no browser")) }))
      .toEqual({ ok: false, reason: "failed" });
  });

  test("a code Google would never send is a failure, not a result", async () => {
    const google = answering((consent) => ({ code: "x".repeat(2049), state: stateOf(consent) }));
    expect(await authorizeWithLoopback(REQUEST, { open: google.open })).toEqual({ ok: false, reason: "failed" });
    await google.browsed();
    expect(google.pages[0]?.status).toBe(400);
  });
});

describe("GoogleConsent", () => {
  test("one consent at a time: a new one cancels the one in progress, and cancel ends it", async () => {
    const opened: string[] = [];
    const consent = new GoogleConsent((url) => {
      opened.push(url);
      return Promise.resolve();
    });
    const first = consent.authorize(REQUEST);
    await expect.poll(() => opened.length).toBe(1);
    const second = consent.authorize(REQUEST);
    expect(await first).toEqual({ ok: false, reason: "cancelled" });
    await expect.poll(() => opened.length).toBe(2);
    consent.cancel();
    expect(await second).toEqual({ ok: false, reason: "cancelled" });
    // Nothing in progress: cancelling is harmless.
    consent.cancel();
  });

  test("the browser's answer reaches the consent in progress", async () => {
    const consent = new GoogleConsent(async (url) => {
      const back = redirectOf(url);
      back.searchParams.set("code", "4/0Acode");
      back.searchParams.set("state", stateOf(new URL(url)));
      await (await fetch(back)).text();
    });
    const result: GoogleAuthorizeResult = await consent.authorize(REQUEST);
    expect(result).toMatchObject({ ok: true, code: "4/0Acode" });
  });

  test("times out after the given delay", async () => {
    const consent = new GoogleConsent(() => Promise.resolve(), 30);
    expect(await consent.authorize(REQUEST)).toEqual({ ok: false, reason: "timeout" });
  });
});
