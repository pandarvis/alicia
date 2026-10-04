import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  type ConversationSummary,
  type HistoryMessage,
  PairingRequest,
  type Person,
} from "@alicia/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { ChatDependencies } from "../conversations/chat-service.ts";
import type { ConversationRepository } from "../conversations/repository.ts";
import type { PairingService } from "../identity/pairing.ts";
import { ConversationLocks } from "./conversation-locks.ts";
import { FailureLimiter } from "./failure-limiter.ts";
import { sendError } from "./http-errors.ts";
import { registerMemoryRoutes } from "./memory-routes.ts";
import { attachWs } from "./ws.ts";

const APP_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/** Origins of the Alicia desktop app: the packaged app (file://, sent as "null") and its local dev server. */
export function isAppOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === "null" || APP_DEV_ORIGIN.test(origin);
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

  // Browser pages may only call the brain from the Alicia app itself: the built app (file:// → "null")
  // or its dev server on this machine. Auth still relies on the device token; this only stops other sites.
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAppOrigin(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  // 128 KiB: the protocol caps messages at 20,000 characters.
  await app.register(websocket, { options: { maxPayload: 131_072 } });

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
    if (pairingFailures.blocked(request.ip)) return sendError(reply, 429, "too_many_attempts");
    const body = PairingRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const result = deps.pairing.redeem(body.data.code, body.data.deviceName);
    if ("error" in result) {
      if (result.error === "invalid_code") pairingFailures.fail(request.ip);
      return sendError(reply, result.error === "too_many_attempts" ? 429 : 401, result.error);
    }
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
    const list: HistoryMessage[] = deps.repository
      .messages(request.params.id)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: iso(m.createdAt) }));
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
    return reply.code(204).send();
  });

  registerMemoryRoutes(app, { memory: deps.chat.memory, repository: deps.repository, personOf });

  app.get("/ws", { websocket: true }, (socket) => {
    attachWs(socket, deps, locks);
  });

  return app;
}
