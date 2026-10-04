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
  /** Fastify's pino logger (default: off, for quiet tests). */
  logging?: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Case-insensitive "Bearer" scheme (RFC 7235). */
const BEARER = /^bearer +(\S+)$/i;

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
      return reply.code(status).send({ error: "invalid_request" });
    }
    request.log.error({ err: error }, "internal error");
    return reply.code(500).send({ error: "internal" });
  });

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

  app.post("/pairing", (request, reply) => {
    const body = PairingRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const result = deps.pairing.redeem(body.data.code, body.data.deviceName);
    if ("error" in result) {
      return reply.code(result.error === "too_many_attempts" ? 429 : 401).send({ error: result.error });
    }
    return result;
  });

  app.get("/conversations", (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const list: ConversationSummary[] = deps.repository
      .list(person.id)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: iso(c.updatedAt) }));
    return list;
  });

  app.get<{ Params: { id: string } }>("/conversations/:id/messages", (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return reply.code(401).send({ error: "unauthenticated" });
    if (deps.repository.get(request.params.id, person.id) === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const list: HistoryMessage[] = deps.repository
      .messages(request.params.id)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: iso(m.createdAt) }));
    return list;
  });

  registerMemoryRoutes(app, { memory: deps.chat.memory, personOf });

  // Shared by every connection: a single turn at a time per conversation.
  const locks = new ConversationLocks();
  app.get("/ws", { websocket: true }, (socket) => {
    attachWs(socket, deps, locks);
  });

  return app;
}
