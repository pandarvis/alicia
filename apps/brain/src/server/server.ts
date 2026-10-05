import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  type ConversationSummary,
  type HistoryMessage,
  PairingRequest,
  type Person,
} from "@alicia/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { toSummary } from "../attachments/store.ts";
import type { ChatDependencies } from "../conversations/chat-service.ts";
import type { ConversationRepository } from "../conversations/repository.ts";
import type { PairingService } from "../identity/pairing.ts";
import { attachmentRoutes } from "./attachment-routes.ts";
import type { DrainOptions } from "./backpressure.ts";
import { ConversationLocks } from "./conversation-locks.ts";
import { addressKey, FailureLimiter } from "./failure-limiter.ts";
import { registerGoogleRoutes } from "./google-routes.ts";
import { sendError } from "./http-errors.ts";
import { registerMemoryRoutes } from "./memory-routes.ts";
import { attachWs } from "./ws.ts";

const APP_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/**
 * Origins of the Alicia desktop app: the packaged app (file:// pages: "null" for fetch, "file://" for the
 * WebSocket upgrade in Chromium) and its local dev server. No Origin at all: CLI, curl, native clients.
 */
export function isAppOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === "null" || origin === "file://" || APP_DEV_ORIGIN.test(origin);
}

/** The app's origins, plus those of the config (`allowedOrigins`). */
export function isAllowedOrigin(origin: string | undefined, extra: ReadonlySet<string>): boolean {
  return isAppOrigin(origin) || (origin !== undefined && extra.has(origin));
}

export interface ServerDependencies {
  pairing: PairingService;
  repository: ConversationRepository;
  chat: ChatDependencies;
  version: string;
  /** Time left to the client to authenticate (default 5 s; adjustable for tests). */
  authTimeoutMs?: number;
  /**
   * Conversations where Alicia is answering. Created by `createServer` when omitted;
   * passed in by tests to simulate a running turn.
   */
  locks?: ConversationLocks;
  /** Fastify's pino logger (default: off, for quiet tests). */
  logging?: boolean;
  /** Web origins allowed besides the app's (config `allowedOrigins`). */
  allowedOrigins?: readonly string[];
  /** Heartbeat period of the WebSocket (default 30 s; shortened by tests). */
  heartbeatMs?: number;
  /** WebSocket backpressure settings (default DEFAULT_DRAIN; adjusted by tests). */
  drain?: DrainOptions;
  /** Time left to answer a confirmation card (default 5 min; shortened by tests). */
  confirmationTimeoutMs?: number;
  /** Published versions of the desktop app, served read-only under /updates/ (omitted in most tests). */
  updatesDir?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Case-insensitive "Bearer" scheme (RFC 7235). */
const BEARER = /^bearer +(\S+)$/i;

const PAIRING_FAILURE_WINDOW_MS = 15 * 60_000;
const PAIRING_MAX_FAILURES = 5;
const PAIRING_MAX_ADDRESSES = 1_000;

/** 4xx status carried by a Fastify error (malformed JSON, body too large…), otherwise undefined. */
function clientStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const status = error.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

export async function createServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    // Never the Authorization header in the log; bodies and messages are not written there.
    logger: deps.logging === true ? { redact: ["req.headers.authorization"] } : false,
    bodyLimit: 1_048_576,
    // Errors raised by the router itself (undecodable URL, parameter too long…) skip the error handler:
    // same typed shape here. Node's own `clientError` answers (malformed HTTP, headers too large → 431)
    // happen before Fastify and stay raw.
    frameworkErrors: (error, request, reply) => {
      const status = clientStatus(error);
      request.log.warn({ code: error.code, status }, "request rejected by the router");
      // The reply is thenable; this hook expects nothing back.
      void (status === undefined ? sendError(reply, 500, "internal") : sendError(reply, status, "invalid_request"));
    },
  });

  // No error leaks to the client: 4xx → invalid_request, everything else → internal (details in the log).
  app.setErrorHandler((error, request, reply) => {
    const status = clientStatus(error);
    if (status !== undefined) {
      request.log.warn({ status }, "request rejected");
      return sendError(reply, status, "invalid_request");
    }
    request.log.error({ err: error }, "internal error");
    return sendError(reply, 500, "internal");
  });
  // Unknown routes answer in the same shape as everything else.
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, "not_found"));

  // 128 KiB: the protocol caps messages at 20,000 characters.
  // Registered before the origin check: its own onRequest hook must mark upgrade requests first, so that
  // a refused upgrade still gets its raw socket destroyed (otherwise the socket lingers and close() hangs).
  await app.register(websocket, { options: { maxPayload: 131_072 } });

  // Desktop app updates (electron-updater, generic provider) and the first download of the installer.
  // Public on purpose: an installer holds no secret, and the brain is only reachable at home or over Tailscale.
  if (deps.updatesDir !== undefined) {
    await app.register(fastifyStatic, {
      root: deps.updatesDir,
      prefix: "/updates/",
      decorateReply: false,
      index: false,
      list: false,
      dotfiles: "deny",
      setHeaders: (reply, path) => {
        // electron-updater must always read the current latest.yml.
        if (path.endsWith(".yml")) reply.header("cache-control", "no-cache");
      },
    });
  }

  const extraOrigins: ReadonlySet<string> = new Set(deps.allowedOrigins ?? []);
  const originAllowed = (origin: string | undefined): boolean => isAllowedOrigin(origin, extraOrigins);

  // Browser pages may only call the brain from the Alicia app or a configured origin. Checked here for
  // every request, the WebSocket upgrade included (browsers do not apply CORS to WebSockets), and before
  // CORS so a foreign preflight stops with a 403. Auth still relies on the device token.
  // Limit: "Origin: null" can be forged by any page (sandboxed iframe, data: URL), so it lets such a page
  // through; what protects the brain then is the device token and the pairing limits. Longer term, the
  // packaged renderer should load from a privileged app:// scheme so "null" can be refused.
  app.addHook("onRequest", (request, reply, done) => {
    if (originAllowed(request.headers.origin)) {
      done();
      return;
    }
    request.log.warn({ origin: request.headers.origin }, "origin refused");
    void sendError(reply, 403, "forbidden_origin");
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, originAllowed(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  const personOf = (request: FastifyRequest): Person | undefined => {
    const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
    return token === undefined ? undefined : deps.pairing.authenticate(token);
  };

  app.get("/health", () => ({ ok: true as const, version: deps.version }));

  // Per address, on top of PairingService's global limit: one machine guessing codes is stopped without
  // locking the whole household out. trustProxy is off on purpose: behind a reverse proxy every request
  // shares the proxy's address, and this becomes a second global limit.
  const pairingFailures = new FailureLimiter({
    clock: deps.chat.clock,
    windowMs: PAIRING_FAILURE_WINDOW_MS,
    maxFailures: PAIRING_MAX_FAILURES,
    maxKeys: PAIRING_MAX_ADDRESSES,
  });

  app.post("/pairing", (request, reply) => {
    // An IPv6 host controls a whole /64: its addresses share one key (see addressKey).
    const address = addressKey(request.ip);
    if (pairingFailures.blocked(address)) return sendError(reply, 429, "too_many_attempts");
    const body = PairingRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const result = deps.pairing.redeem(body.data.code, body.data.deviceName);
    if ("error" in result) {
      if (result.error === "invalid_code") pairingFailures.fail(address);
      return sendError(reply, result.error === "too_many_attempts" ? 429 : 401, result.error);
    }
    pairingFailures.succeed(address);
    return result;
  });

  app.get("/conversations", (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const list: ConversationSummary[] = deps.repository
      .list(person.id)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: iso(c.updatedAt) }));
    return list;
  });

  // Shared by every connection and by deletions: a single turn at a time per conversation.
  const locks = deps.locks ?? new ConversationLocks();

  app.get<{ Params: { id: string } }>("/conversations/:id/messages", (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    if (deps.repository.get(request.params.id, person.id) === undefined) {
      return sendError(reply, 404, "not_found");
    }
    const byMessage = deps.chat.attachments.byMessage(request.params.id);
    const list: HistoryMessage[] = deps.repository
      .messages(request.params.id)
      .map((m) => ({
        id: m.id, role: m.role, text: m.text, createdAt: iso(m.createdAt),
        attachments: (byMessage.get(m.id) ?? []).map(toSummary),
      }));
    return list;
  });

  app.delete<{ Params: { id: string } }>("/conversations/:id", (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const { id } = request.params;
    if (deps.repository.get(id, person.id) === undefined) {
      return sendError(reply, 404, "not_found");
    }
    // Holding the turn lock while deleting: no turn can start on this conversation meanwhile.
    if (!locks.acquire(person.id, id)) return sendError(reply, 409, "busy");
    try {
      deps.repository.delete(id, person.id);
    } finally {
      locks.release(person.id, id);
    }
    // Its attachment rows went with it: their files go too. A file that cannot be removed now (locked) does not
    // undo the deletion: the startup sweep removes the folder later.
    try {
      deps.chat.attachments.removeConversationFiles(id);
    } catch (error) {
      request.log.error({ err: error }, "attachment files left behind");
    }
    return reply.code(204).send();
  });

  registerMemoryRoutes(app, { memory: deps.chat.memory, repository: deps.repository, personOf });
  registerGoogleRoutes(app, { google: deps.chat.google, personOf });
  await app.register(attachmentRoutes({ attachments: deps.chat.attachments, personOf }));

  app.route({
    method: "GET",
    url: "/ws",
    // A plain GET (no upgrade) gets the typed 404 like any other unknown resource.
    handler: (_request, reply) => sendError(reply, 404, "not_found"),
    wsHandler: (socket) => {
      attachWs(socket, deps, locks);
    },
  });

  return app;
}
