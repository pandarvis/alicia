import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GOOGLE_SCOPES } from "@alicia/protocol";
import { type GoogleAuthorizeRequest, GoogleAuthorizeResult } from "../shared/google.ts";

/** Google's consent page: the only place the consent URL ever points to (built here, never by a page). */
export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";
/** How long the browser has to come back to the app. */
export const CONSENT_TIMEOUT_MS = 5 * 60_000;
const LOOPBACK_HOST = "127.0.0.1";

const PAGE_CSS =
  "body{font-family:system-ui,sans-serif;background:#16213e;color:#f3ebdd;display:grid;place-items:center;" +
  "min-height:100vh;margin:0;text-align:center}h1{font-size:1.6rem;margin:0 0 .5rem}p{margin:0;color:#cfc6b8}";
/** The page runs nothing and loads nothing: only its own style block, pinned by hash. */
const PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(PAGE_CSS).digest("base64")}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PAGES = {
  done: { status: 200, title: "C'est fait !", text: "Tu peux fermer cet onglet et revenir dans Alicia." },
  denied: { status: 200, title: "Annulé", text: "La connexion n'a pas été faite. Tu peux fermer cet onglet." },
  failed: { status: 400, title: "Annulé", text: "Google n'a pas renvoyé de réponse valable. Recommence depuis Alicia." },
  forged: { status: 400, title: "Lien refusé", text: "Ce lien ne vient pas d'Alicia. Recommence depuis l'app." },
} as const;
type PageName = keyof typeof PAGES;

export interface LoopbackOptions {
  /** Opens the consent page in the system browser (through the OS integration port: a recorder in tests). */
  open: (url: string) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** PKCE (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Constant-time comparison (the length of the expected state is no secret). */
function sameSecret(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A small French page; nothing in it comes from the request. Never cached, never referred. */
function answer(response: ServerResponse, name: PageName): void {
  const { status, title, text } = PAGES[name];
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": PAGE_CSP,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Alicia</title><style>${PAGE_CSS}</style></head>` +
      `<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
  );
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { "cache-control": "no-store", connection: "close" }).end();
}

/** The one parameter of that name, or null when it is missing or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * Google's consent in the system browser, its answer caught on http://127.0.0.1:<random port> (RFC 8252). Only
 * `GET /` on that exact host is heard; the state is compared in constant time, and a request with a wrong state is
 * answered without ending the flow (another local program cannot cancel it). The server is closed whatever the
 * outcome. The code and the verifier are never logged. The permissions asked are always GOOGLE_SCOPES.
 *
 * Accepted risks: another program of the same Windows user could race the browser to the loopback with a code of its
 * own, or read the code on the way — PKCE makes a code useless without the verifier, which never leaves this process
 * but for the brain. The code, verifier and redirect then travel to the brain like everything else the app sends it
 * (with the device token, over Tailscale or the home network). Someone on the network swapping the client id would
 * have to sit between the app and the brain, which the same channel already trusts.
 */
export function authorizeWithLoopback(request: GoogleAuthorizeRequest, options: LoopbackOptions): Promise<GoogleAuthorizeResult> {
  if (options.signal?.aborted === true) return Promise.resolve({ ok: false, reason: "cancelled" });
  return new Promise((resolve) => {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(32).toString("base64url");
    let redirectUri = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function onRequest(req: IncomingMessage, res: ServerResponse): void {
      if (settled || redirectUri === "") {
        notFound(res);
        return;
      }
      const url = URL.parse(req.url ?? "/", redirectUri);
      const heard = url !== null && req.method === "GET" && url.origin === redirectUri && url.pathname === "/" &&
        `http://${req.headers.host ?? ""}` === redirectUri;
      if (!heard) {
        notFound(res);
        return;
      }
      if (!sameSecret(single(url.searchParams, "state") ?? "", state)) {
        answer(res, "forged");
        return;
      }
      const code = single(url.searchParams, "code");
      if (url.searchParams.has("error") || code === null || code === "") {
        answer(res, "denied");
        finish({ ok: false, reason: "denied" });
        return;
      }
      const result = GoogleAuthorizeResult.safeParse({ ok: true, code, codeVerifier: verifier, redirectUri });
      if (!result.success) {
        answer(res, "failed");
        finish({ ok: false, reason: "failed" });
        return;
      }
      answer(res, "done");
      finish(result.data);
    }

    const server = createServer(onRequest);

    function finish(result: GoogleAuthorizeResult): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      server.close();
      // The answer being written still goes out (connection: close); nothing else stays open.
      server.closeIdleConnections();
      resolve(result);
    }

    function cancel(): void {
      finish({ ok: false, reason: "cancelled" });
    }

    server.on("error", () => {
      finish({ ok: false, reason: "failed" });
    });
    options.signal?.addEventListener("abort", cancel, { once: true });
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (settled || address === null || typeof address === "string") {
        finish({ ok: false, reason: "failed" });
        server.close();
        return;
      }
      redirectUri = `http://${LOOPBACK_HOST}:${address.port}`;
      const consent = new URL(GOOGLE_AUTHORIZATION_URL);
      consent.search = new URLSearchParams({
        client_id: request.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // A refresh token every time (reconnections included).
        access_type: "offline",
        prompt: "consent",
        ...(request.loginHint !== undefined ? { login_hint: request.loginHint } : {}),
      }).toString();
      // Only ever Google's own page in the person's browser.
      if (consent.origin !== GOOGLE_ACCOUNTS_ORIGIN) {
        finish({ ok: false, reason: "failed" });
        return;
      }
      timer = setTimeout(() => {
        finish({ ok: false, reason: "timeout" });
      }, options.timeoutMs ?? CONSENT_TIMEOUT_MS);
      options.open(consent.href).catch(() => {
        finish({ ok: false, reason: "failed" });
      });
    });
  });
}

/** One consent at a time for the app: a new one cancels the one in progress. */
export class GoogleConsent {
  readonly #open: (url: string) => Promise<void>;
  readonly #timeoutMs: number;
  #pending: AbortController | null = null;

  constructor(open: (url: string) => Promise<void>, timeoutMs: number = CONSENT_TIMEOUT_MS) {
    this.#open = open;
    this.#timeoutMs = timeoutMs;
  }

  async authorize(request: GoogleAuthorizeRequest): Promise<GoogleAuthorizeResult> {
    this.#pending?.abort();
    const controller = new AbortController();
    this.#pending = controller;
    try {
      return await authorizeWithLoopback(request, { open: this.#open, signal: controller.signal, timeoutMs: this.#timeoutMs });
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }

  /** Cancels the consent in progress, if any (its loopback closes at once). */
  cancel(): void {
    this.#pending?.abort();
  }
}
