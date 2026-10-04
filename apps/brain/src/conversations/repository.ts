import { randomUUID } from "node:crypto";
import type { Model } from "@alicia/protocol";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { conversations, messages, turnLog } from "../db/schema.ts";
import type { Clock } from "../clock.ts";

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Role = Message["role"];

export interface LoggedToolCall {
  callId: string;
  tool: string;
  success: boolean | null;
}

export interface TurnLogEntry {
  conversationId: string;
  model: Model;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  tools: readonly LoggedToolCall[];
  error: string | null;
}

/**
 * Repository for conversations, messages and the turn log.
 *
 * Isolation: only `get` checks ownership. `setSession`, `addMessage`, `messages` and
 * `lastMessages` only take a `conversationId` and do NOT check who it belongs to:
 * the caller must first go through `get(id, personId)`.
 */
export class ConversationRepository {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  create(personId: string, title: string): Conversation {
    const now = this.#clock();
    const c: Conversation = {
      id: randomUUID(), personId, title, sessionId: null, createdAt: now, updatedAt: now,
    };
    this.#db.insert(conversations).values(c).run();
    return c;
  }

  /** Returns the conversation only if it belongs to this person. */
  get(id: string, personId: string): Conversation | undefined {
    return this.#db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.personId, personId)))
      .get();
  }

  list(personId: string): Conversation[] {
    return this.#db
      .select()
      .from(conversations)
      .where(eq(conversations.personId, personId))
      .orderBy(desc(conversations.updatedAt), sql`rowid desc`)
      .limit(100)
      .all();
  }

  setSession(id: string, sessionId: string | null): void {
    this.#db.update(conversations).set({ sessionId }).where(eq(conversations.id, id)).run();
  }

  addMessage(conversationId: string, role: Role, text: string): void {
    const now = this.#clock();
    this.#db.transaction((tx) => {
      tx.insert(messages)
        .values({ id: randomUUID(), conversationId, role, text, createdAt: now })
        .run();
      tx.update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, conversationId))
        .run();
    });
  }

  messages(conversationId: string): Message[] {
    return this.#db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), sql`rowid`)
      .all();
  }

  lastMessages(conversationId: string, count: number): Message[] {
    return this.#db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt), sql`rowid desc`)
      .limit(count)
      .all()
      .reverse();
  }

  logTurn(entry: TurnLogEntry): void {
    this.#db
      .insert(turnLog)
      .values({
        id: randomUUID(),
        conversationId: entry.conversationId,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        durationMs: entry.durationMs,
        tools: JSON.stringify(entry.tools),
        error: entry.error,
        createdAt: this.#clock(),
      })
      .run();
  }
}
