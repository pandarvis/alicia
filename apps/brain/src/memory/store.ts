import { randomUUID } from "node:crypto";
import type { MemoryKind, MemoryScope } from "@alicia/protocol";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/open.ts";
import { memories } from "../db/schema.ts";
import { cosine, type Embedder, fromBlob, toBlob } from "./embedder.ts";
import { ftsQuery, fuse } from "./ranking.ts";

export type MemoryRow = typeof memories.$inferSelect;
/** A memory without its vector, as the rest of the brain sees it. */
export type Memory = Omit<MemoryRow, "embedding" | "embeddingModel" | "importKey">;

export interface RememberInput {
  personId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  text: string;
  source: MemoryRow["source"];
  pinned?: boolean;
  conversationId?: string;
  /** Import only: keeps the original bookkeeping. */
  importKey?: string;
  createdAt?: number;
  recallCount?: number;
  lastRecalledAt?: number | null;
}

/** Why a text is not stored: a secret (password, code, bank detail) or nothing at all. */
export type RefusalReason = "secret" | "empty";

export type RememberResult =
  | { status: "created"; memory: Memory }
  | { status: "duplicate"; memory: Memory }
  | { status: "refused"; reason: RefusalReason };

export type UpdateResult =
  | { status: "updated"; memory: Memory }
  | { status: "not_found" }
  | { status: "refused"; reason: RefusalReason };

export interface SearchOptions {
  /** At most this many results (default 8). */
  limit?: number;
  /** Counts the hits as recalled (default true); a screen listing results passes false. */
  recall?: boolean;
}

export interface MemoryPatchInput {
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  pinned?: boolean;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  kind?: MemoryKind;
}

export interface MemoryStoreOptions {
  /** Same-scope similarity at or above which a new memory is a duplicate. */
  duplicateThreshold?: number;
  /** Below this similarity a vector-only match is noise (e5 has a high floor). */
  minSimilarity?: number;
}

export interface SheetMemories {
  rules: Memory[];
  pinnedCommon: Memory[];
  pinnedPersonal: Memory[];
}

const COMMON = "common";
const CANDIDATES = 50;
const SEARCH_LIMIT = 8;
const FORGET_RETENTION_MS = 30 * 24 * 3_600_000;
/** Words that name a secret. Letter boundaries are Unicode-aware (`\b` ignores accented letters). */
const SECRET_WORDS =
  /(?<![\p{L}\p{N}])(mots? de passe|passwords?|mdp|code\s*pin|pin\s*:?\s*\d|codes? (d['’]acc[eè]s|secrets?|du wifi|wifi|de l['’]alarme|alarme|du portail|portail)|digicodes?|iban|cvv|cryptogrammes?)(?!\p{L})/iu;
/** "code" followed closely by a number ("le code de la porte : 4521"), postal codes aside. */
const SECRET_CODE = /(?<![\p{L}\p{N}])codes?(?!\s+posta(?:l|ux))[^.!?\n]{0,30}?\d{3,}/iu;

function refusal(text: string): RefusalReason | undefined {
  if (text === "") return "empty";
  if (SECRET_WORDS.test(text) || SECRET_CODE.test(text)) return "secret";
  return undefined;
}

function strip(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    text: row.text,
    pinned: row.pinned,
    source: row.source,
    conversationId: row.conversationId,
    recallCount: row.recallCount,
    lastRecalledAt: row.lastRecalledAt,
    forgottenAt: row.forgottenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The household's memories. A person reads and writes the common memories and their own, never
 * another person's: a `scope` argument is relative ("personal" = the person acting).
 */
export class MemoryStore {
  readonly #db: Db;
  readonly #embedder: Embedder;
  readonly #clock: Clock;
  readonly #duplicateThreshold: number;
  readonly #minSimilarity: number;

  constructor(db: Db, embedder: Embedder, clock: Clock, options: MemoryStoreOptions = {}) {
    this.#db = db;
    this.#embedder = embedder;
    this.#clock = clock;
    this.#duplicateThreshold = options.duplicateThreshold ?? 0.92;
    this.#minSimilarity = options.minSimilarity ?? 0.8;
  }

  /** Scopes a person may read and write: the household's and their own. */
  #scopes(personId: string): string[] {
    return [COMMON, personId];
  }

  #storedScope(personId: string, scope: MemoryScope): string {
    return scope === "common" ? COMMON : personId;
  }

  /** SQL condition: the memory is active and within the person's reach. */
  #reachable(personId: string) {
    return and(inArray(memories.scope, this.#scopes(personId)), isNull(memories.forgottenAt));
  }

  #visible(personId: string, id: string): MemoryRow | undefined {
    return this.#db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), this.#reachable(personId)))
      .get();
  }

  async #embed(text: string, kind: "query" | "passage"): Promise<Float32Array> {
    const [vector] = await this.#embedder.embed([text], kind);
    if (vector === undefined) throw new Error("Embedder returned no vector");
    return vector;
  }

  get(personId: string, id: string): Memory | undefined {
    const row = this.#visible(personId, id);
    return row === undefined ? undefined : strip(row);
  }

  list(personId: string, filter: MemoryFilter): Memory[] {
    const scopes = filter.scope === undefined ? this.#scopes(personId) : [this.#storedScope(personId, filter.scope)];
    return this.#db
      .select()
      .from(memories)
      .where(
        and(
          inArray(memories.scope, scopes),
          isNull(memories.forgottenAt),
          filter.kind === undefined ? undefined : eq(memories.kind, filter.kind),
        ),
      )
      .orderBy(desc(memories.updatedAt), sql`rowid desc`)
      .all()
      .map(strip);
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const text = input.text.trim();
    const reason = refusal(text);
    if (reason !== undefined) return { status: "refused", reason };
    const scope = this.#storedScope(input.personId, input.scope);
    const vector = await this.#embed(text, "passage");

    const duplicate = this.#closest(vector, [scope]);
    if (duplicate !== undefined && duplicate.similarity >= this.#duplicateThreshold) {
      const existing = this.#visible(input.personId, duplicate.id);
      if (existing !== undefined) return { status: "duplicate", memory: strip(existing) };
    }

    const now = this.#clock();
    const row: MemoryRow = {
      id: randomUUID(),
      scope,
      kind: input.kind,
      text,
      pinned: input.pinned ?? false,
      source: input.source,
      conversationId: input.conversationId ?? null,
      importKey: input.importKey ?? null,
      embedding: toBlob(vector),
      embeddingModel: this.#embedder.model,
      recallCount: input.recallCount ?? 0,
      lastRecalledAt: input.lastRecalledAt ?? null,
      forgottenAt: null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    this.#db.insert(memories).values(row).run();
    return { status: "created", memory: strip(row) };
  }

  hasImportKey(importKey: string): boolean {
    return this.#db.select({ id: memories.id }).from(memories).where(eq(memories.importKey, importKey)).get() !== undefined;
  }

  /** Hybrid search (full text + similarity) within the person's scopes; counts each hit as a recall. */
  async search(personId: string, query: string, options: SearchOptions = {}): Promise<Memory[]> {
    const scopes = this.#scopes(personId);
    const textRanked = this.#fullText(query, scopes);
    const vector = await this.#embed(query, "query");
    const vectorRanked = this.#comparable(scopes)
      .map((row) => ({ id: row.id, similarity: cosine(vector, fromBlob(row.embedding)) }))
      .filter((hit) => hit.similarity >= this.#minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATES)
      .map((hit) => hit.id);

    const ids = fuse([textRanked, vectorRanked]).slice(0, Math.max(0, options.limit ?? SEARCH_LIMIT));
    if (ids.length === 0) return [];
    // The embedding was awaited: re-check reach, a memory may have moved or been forgotten meanwhile.
    const found = and(inArray(memories.id, ids), this.#reachable(personId));
    if (options.recall ?? true) {
      this.#db
        .update(memories)
        .set({ recallCount: sql`${memories.recallCount} + 1`, lastRecalledAt: this.#clock() })
        .where(found)
        .run();
    }
    const rows = new Map(
      this.#db
        .select()
        .from(memories)
        .where(found)
        .all()
        .map((row) => [row.id, row]),
    );
    return ids.flatMap((id) => {
      const row = rows.get(id);
      return row === undefined ? [] : [strip(row)];
    });
  }

  /** Edits a visible memory; a scope change moves it between common and the person's own. */
  async update(personId: string, id: string, patch: MemoryPatchInput): Promise<UpdateResult> {
    const text = patch.text?.trim();
    const reason = text === undefined ? undefined : refusal(text);
    if (reason !== undefined) return { status: "refused", reason };
    const row = this.#visible(personId, id);
    if (row === undefined) return { status: "not_found" };
    const reembed = text !== undefined && (text !== row.text || row.embeddingModel !== this.#embedder.model);
    const embedding = reembed ? toBlob(await this.#embed(text, "passage")) : undefined;
    const next: Partial<MemoryRow> = {
      ...(text !== undefined ? { text } : {}),
      ...(embedding !== undefined ? { embedding, embeddingModel: this.#embedder.model } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.scope !== undefined ? { scope: this.#storedScope(personId, patch.scope) } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updatedAt: this.#clock(),
    };
    // Guarded write: the embedding was awaited, so the memory may have left this person's reach meanwhile.
    const { changes } = this.#db
      .update(memories)
      .set(next)
      .where(and(eq(memories.id, id), this.#reachable(personId)))
      .run();
    const memory = changes === 1 ? this.get(personId, id) : undefined;
    return memory === undefined ? { status: "not_found" } : { status: "updated", memory };
  }

  /** Soft forget: hidden at once, purged for good after 30 days. */
  forget(personId: string, id: string): boolean {
    if (this.#visible(personId, id) === undefined) return false;
    this.#db.update(memories).set({ forgottenAt: this.#clock() }).where(eq(memories.id, id)).run();
    return true;
  }

  /** Deletes memories forgotten more than 30 days ago; returns how many. */
  purgeForgotten(): number {
    return this.#db
      .delete(memories)
      .where(and(isNotNull(memories.forgottenAt), lt(memories.forgottenAt, this.#clock() - FORGET_RETENTION_MS)))
      .run().changes;
  }

  /** What the permanent sheet shows for this person (house rules, pinned memories). */
  sheetMemories(personId: string): SheetMemories {
    const pinnedOrRule = this.#db
      .select()
      .from(memories)
      .where(
        and(
          this.#reachable(personId),
          or(eq(memories.pinned, true), and(eq(memories.kind, "rule"), eq(memories.scope, COMMON))),
        ),
      )
      .orderBy(desc(memories.recallCount), asc(memories.createdAt))
      .all()
      .map(strip);
    return {
      rules: pinnedOrRule.filter((m) => m.kind === "rule" && m.scope === COMMON),
      pinnedCommon: pinnedOrRule.filter((m) => m.scope === COMMON && m.kind !== "rule"),
      pinnedPersonal: pinnedOrRule.filter((m) => m.scope === personId),
    };
  }

  /**
   * Active memories whose vector comes from the current embedding model: vectors from another
   * model live in another space and are never compared (they are re-embedded separately).
   */
  #comparable(scopes: string[]): { id: string; embedding: Buffer }[] {
    return this.#db
      .select({ id: memories.id, embedding: memories.embedding })
      .from(memories)
      .where(
        and(
          inArray(memories.scope, scopes),
          isNull(memories.forgottenAt),
          eq(memories.embeddingModel, this.#embedder.model),
        ),
      )
      .all();
  }

  #closest(vector: Float32Array, scopes: string[]): { id: string; similarity: number } | undefined {
    let best: { id: string; similarity: number } | undefined;
    for (const row of this.#comparable(scopes)) {
      const similarity = cosine(vector, fromBlob(row.embedding));
      if (best === undefined || similarity > best.similarity) best = { id: row.id, similarity };
    }
    return best;
  }

  #fullText(query: string, scopes: string[]): string[] {
    const match = ftsQuery(query);
    if (match === null) return [];
    const placeholders = scopes.map(() => "?").join(", ");
    return this.#db.$client
      .prepare(
        `SELECT m.id AS id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.scope IN (${placeholders}) AND m.forgotten_at IS NULL
         ORDER BY bm25(memories_fts) LIMIT ${CANDIDATES}`,
      )
      .all(match, ...scopes)
      .flatMap((row) => (typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? [row.id] : []));
  }
}
