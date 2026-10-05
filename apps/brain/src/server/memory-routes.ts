import {
  MemoryCreate,
  MemoryKind,
  MemoryPatch,
  MemoryScope,
  type MemorySummary,
  type MemoryTestHit,
  type Person,
} from "@alicia/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConversationRepository } from "../conversations/repository.ts";
import type { Memory, MemoryStore } from "../memory/store.ts";
import { deviceAuth } from "./device-auth.ts";
import { refusedBody, sendError } from "./http-errors.ts";

export interface MemoryRoutesDependencies {
  memory: MemoryStore;
  /** Gives the title of the conversation a memory came from. */
  repository: ConversationRepository;
  /** The person behind the request's Bearer token, undefined if not authenticated. */
  personOf: (request: FastifyRequest) => Person | undefined;
}

const MemoryQuery = z.object({
  scope: MemoryScope.optional(),
  kind: MemoryKind.optional(),
  q: z.string().trim().min(1).max(300).optional(),
  forgotten: z.enum(["true", "false"]).optional(),
});

const TestQuery = z.object({ q: z.string().trim().min(1).max(300) });

/** Search candidates are filtered afterwards: ask for the store's maximum so the filter does not starve the list. */
const SEARCH_LIMIT = 50;

/** Alicia's own search limit: the test bench shows exactly what she would receive. */
const TEST_LIMIT = 8;

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

/** Cosine similarity may overshoot [-1, 1] by a float rounding error; the protocol bounds it. */
const clampSimilarity = (value: number): number => Math.min(1, Math.max(-1, value));

/** The stored scope is "common" or a person id; seen from the caller, the latter is "personal". */
function summary(memory: Memory, conversationTitle: string | null): MemorySummary {
  return {
    id: memory.id,
    scope: memory.scope === "common" ? "common" : "personal",
    kind: memory.kind,
    text: memory.text,
    pinned: memory.pinned,
    source: memory.source,
    conversationId: memory.conversationId,
    conversationTitle,
    createdAt: iso(memory.createdAt),
    updatedAt: iso(memory.updatedAt),
    recallCount: memory.recallCount,
    lastRecalledAt: isoOrNull(memory.lastRecalledAt),
    forgottenAt: isoOrNull(memory.forgottenAt),
  };
}

/** `/memories` routes: every one needs a Bearer token and acts within the caller's reach. */
export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRoutesDependencies): void {
  const { memory, repository, personOf } = deps;
  // Every route checks the device before its body is read.
  const auth = deviceAuth(personOf);
  const guard = { onRequest: auth.onRequest };

  /** A memory as the caller sees it: the source conversation's title only if the conversation is the caller's own. */
  const summarize = (person: Person, m: Memory): MemorySummary => {
    const title = m.conversationId === null ? undefined : repository.get(m.conversationId, person.id)?.title;
    return summary(m, title ?? null);
  };

  app.get("/memories", guard, async (request, reply) => {
    const person = auth.person(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const query = MemoryQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, "invalid_request");
    const { scope, kind, q, forgotten } = query.data;
    const trash = forgotten === "true";
    if (trash && q !== undefined) return sendError(reply, 400, "invalid_request");
    const filter = {
      ...(scope !== undefined ? { scope } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
    const matches = (m: Memory): boolean =>
      (scope === undefined || (m.scope === "common") === (scope === "common")) && (kind === undefined || m.kind === kind);
    if (trash) return memory.listForgotten(person.id).filter(matches).map((m) => summarize(person, m));
    if (q === undefined) return memory.list(person.id, filter).map((m) => summarize(person, m));
    // Browsing is not recalling: only Alicia's own searches count as recalls.
    const hits = await memory.search(person.id, q, { limit: SEARCH_LIMIT, recall: false });
    return hits.filter(matches).map((m) => summarize(person, m));
  });

  // The test bench: what Alicia would find for a question, and why. Never counts as a recall.
  app.get("/memories/test", guard, async (request, reply) => {
    const person = auth.person(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const query = TestQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, "invalid_request");
    const explained = await memory.explain(person.id, query.data.q, TEST_LIMIT);
    const hits: MemoryTestHit[] = explained.map((hit) => ({
      memory: summarize(person, hit.memory),
      rank: hit.rank,
      textMatch: hit.textMatch,
      similarity: clampSimilarity(hit.similarity),
    }));
    return hits;
  });

  app.post("/memories", guard, async (request, reply) => {
    const person = auth.person(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const body = MemoryCreate.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const { text, kind, scope, pinned } = body.data;
    const result = await memory.remember({
      personId: person.id,
      source: "manual",
      text,
      kind,
      scope,
      ...(pinned !== undefined ? { pinned } : {}),
    });
    if (result.status === "created") return reply.code(201).send(summarize(person, result.memory));
    if (result.status === "duplicate") return sendError(reply, 409, "duplicate");
    return reply.code(422).send(refusedBody(result.reason));
  });

  app.patch<{ Params: { id: string } }>("/memories/:id", guard, async (request, reply) => {
    const person = auth.person(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const body = MemoryPatch.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const { text, kind, scope, pinned } = body.data;
    const result = await memory.update(person.id, request.params.id, {
      ...(text !== undefined ? { text } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
    });
    if (result.status === "updated") return summarize(person, result.memory);
    if (result.status === "not_found") return sendError(reply, 404, "not_found");
    return reply.code(422).send(refusedBody(result.reason));
  });

  app.post<{ Params: { id: string } }>("/memories/:id/restore", guard, (request, reply) => {
    const person = auth.person(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    const restored = memory.restore(person.id, request.params.id);
    if (restored === undefined) return sendError(reply, 404, "not_found");
    return summarize(person, restored);
  });

  app.delete<{ Params: { id: string } }>("/memories/:id", guard, (request, reply) => {
    const person = auth.person(request);
    if (person === undefined) return sendError(reply, 401, "unauthenticated");
    if (!memory.forget(person.id, request.params.id)) return sendError(reply, 404, "not_found");
    return reply.code(204).send();
  });
}
