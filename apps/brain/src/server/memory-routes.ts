import { MemoryCreate, MemoryKind, MemoryPatch, MemoryScope, type MemorySummary, type Person } from "@alicia/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Memory, MemoryStore } from "../memory/store.ts";

export interface MemoryRoutesDependencies {
  memory: MemoryStore;
  /** The person behind the request's Bearer token, undefined if not authenticated. */
  personOf: (request: FastifyRequest) => Person | undefined;
}

const MemoryQuery = z.object({
  scope: MemoryScope.optional(),
  kind: MemoryKind.optional(),
  q: z.string().trim().min(1).max(300).optional(),
});

/** Search candidates are filtered afterwards: ask for the store's maximum so the filter does not starve the list. */
const SEARCH_LIMIT = 50;

const iso = (ms: number): string => new Date(ms).toISOString();

/** The stored scope is "common" or a person id; seen from the caller, the latter is "personal". */
function summary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    scope: memory.scope === "common" ? "common" : "personal",
    kind: memory.kind,
    text: memory.text,
    pinned: memory.pinned,
    createdAt: iso(memory.createdAt),
    updatedAt: iso(memory.updatedAt),
    recallCount: memory.recallCount,
  };
}

/** `/memories` routes: every one needs a Bearer token and acts within the caller's reach. */
export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRoutesDependencies): void {
  const { memory, personOf } = deps;

  app.get("/memories", async (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const query = MemoryQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const { scope, kind, q } = query.data;
    const filter = {
      ...(scope !== undefined ? { scope } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
    if (q === undefined) return memory.list(person.id, filter).map(summary);
    // Browsing is not recalling: only Alicia's own searches count as recalls.
    const hits = await memory.search(person.id, q, { limit: SEARCH_LIMIT, recall: false });
    return hits
      .filter((m) => (scope === undefined || (m.scope === "common") === (scope === "common")) && (kind === undefined || m.kind === kind))
      .map(summary);
  });

  app.post("/memories", async (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const body = MemoryCreate.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const { text, kind, scope, pinned } = body.data;
    const result = await memory.remember({
      personId: person.id,
      source: "manual",
      text,
      kind,
      scope,
      ...(pinned !== undefined ? { pinned } : {}),
    });
    if (result.status === "created") return reply.code(201).send(summary(result.memory));
    if (result.status === "duplicate") return reply.code(409).send({ error: "duplicate" });
    return reply.code(422).send({ error: "refused", reason: result.reason });
  });

  app.patch<{ Params: { id: string } }>("/memories/:id", async (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const body = MemoryPatch.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const { text, kind, scope, pinned } = body.data;
    const result = await memory.update(person.id, request.params.id, {
      ...(text !== undefined ? { text } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
    });
    if (result.status === "updated") return summary(result.memory);
    if (result.status === "not_found") return reply.code(404).send({ error: "not_found" });
    return reply.code(422).send({ error: "refused", reason: result.reason });
  });

  app.delete<{ Params: { id: string } }>("/memories/:id", (request, reply) => {
    const person = personOf(request);
    if (person === undefined) return reply.code(401).send({ error: "unauthenticated" });
    if (!memory.forget(person.id, request.params.id)) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });
}
