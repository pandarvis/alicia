import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AttachmentRefusalReason, type AttachmentSummary, checkAttachment } from "@alicia/protocol";
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/open.ts";
import { attachments } from "../db/schema.ts";
import { contentMatches } from "./sniff.ts";

export type Attachment = typeof attachments.$inferSelect;
export type UploadResult =
  | { status: "stored"; attachment: Attachment }
  | { status: "refused"; reason: AttachmentRefusalReason };

/** An upload not sent in a message within a day is dropped. */
export const PENDING_TTL_MS = 24 * 3_600_000;
const PENDING_DIR = "pending";
const NAME_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display name: last path segment, NFC, no control or formatting characters, at most 200 characters (extension kept). */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/u).at(-1) ?? "";
  const clean = base.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (clean.length <= NAME_MAX) return clean;
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? clean.slice(dot) : "";
  return `${clean.slice(0, NAME_MAX - extension.length)}${extension}`;
}

const fileName = (a: Pick<Attachment, "id" | "extension">): string => `${a.id}${a.extension}`;

export function toSummary(a: Attachment): AttachmentSummary {
  return { id: a.id, name: a.name, kind: a.kind, size: a.size };
}

/**
 * Attachment files and rows. An upload is "pending" (owned by its person, in <root>/pending) until a message
 * claims it; it then lives in <root>/<conversationId>, the only folder the built-in Read may reach during that
 * conversation's turns. File names on disk are generated (<id><extension>): the name the person gave is only
 * kept in the database, for display.
 */
export class AttachmentStore {
  readonly #db: Db;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(db: Db, root: string, clock: Clock) {
    this.#db = db;
    this.#root = root;
    this.#clock = clock;
  }

  /** A conversation's folder; only a UUID ever becomes a path. */
  dirOf(conversationId: string): string {
    if (!UUID.test(conversationId)) throw new Error("Invalid conversation id");
    return join(this.#root, conversationId);
  }

  /** The conversation's folder when it exists (the SDK is only given existing directories). */
  readableDirs(conversationId: string): string[] {
    const dir = this.dirOf(conversationId);
    return existsSync(dir) ? [dir] : [];
  }

  upload(personId: string, rawName: string, bytes: Uint8Array): UploadResult {
    const name = cleanName(rawName);
    const check = checkAttachment(name, bytes.byteLength);
    if (!check.ok) return { status: "refused", reason: check.reason };
    // A file whose content is not what its extension says is refused like an unsupported type.
    if (!contentMatches(check.type.extension, bytes)) return { status: "refused", reason: "unsupported" };
    const attachment: Attachment = {
      id: randomUUID(), personId, conversationId: null, messageId: null, name,
      kind: check.type.kind, extension: check.type.extension, size: bytes.byteLength, createdAt: this.#clock(),
    };
    mkdirSync(join(this.#root, PENDING_DIR), { recursive: true });
    const path = this.#pendingPath(attachment);
    writeFileSync(path, bytes, { flag: "wx" });
    try {
      this.#db.insert(attachments).values(attachment).run();
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    return { status: "stored", attachment };
  }

  /** The person's pending uploads with these ids, in this order; undefined if any is unknown, someone else's, sent or expired. */
  pending(personId: string, ids: readonly string[]): Attachment[] | undefined {
    if (ids.length === 0) return [];
    if (new Set(ids).size !== ids.length) return undefined;
    const rows = this.#db
      .select()
      .from(attachments)
      .where(and(
        inArray(attachments.id, [...ids]),
        eq(attachments.personId, personId),
        isNull(attachments.conversationId),
        gte(attachments.createdAt, this.#clock() - PENDING_TTL_MS),
      ))
      .all();
    const ordered = ids.map((id) => rows.find((r) => r.id === id));
    return ordered.every((a): a is Attachment => a !== undefined) ? ordered : undefined;
  }

  /** Moves pending uploads into the conversation, linked to the user message carrying them. */
  claim(pending: readonly Attachment[], conversationId: string, messageId: string): Attachment[] {
    if (pending.length === 0) return [];
    const dir = this.dirOf(conversationId);
    mkdirSync(dir, { recursive: true });
    for (const a of pending) renameSync(this.#pendingPath(a), join(dir, fileName(a)));
    this.#db.transaction((tx) => {
      for (const a of pending) tx.update(attachments).set({ conversationId, messageId }).where(eq(attachments.id, a.id)).run();
    });
    return pending.map((a) => ({ ...a, conversationId, messageId }));
  }

  /** An attachment of this conversation and its file; undefined for anything else. */
  pathOf(conversationId: string, id: string): { attachment: Attachment; path: string } | undefined {
    const attachment = this.#db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.conversationId, conversationId)))
      .get();
    return attachment === undefined ? undefined : { attachment, path: join(this.dirOf(conversationId), fileName(attachment)) };
  }

  /** A conversation's attachments by message id (for the history), in upload order. */
  byMessage(conversationId: string): Map<string, Attachment[]> {
    const map = new Map<string, Attachment[]>();
    const rows = this.#db
      .select()
      .from(attachments)
      .where(eq(attachments.conversationId, conversationId))
      .orderBy(asc(attachments.createdAt), sql`rowid`)
      .all();
    for (const a of rows) {
      if (a.messageId === null) continue;
      map.set(a.messageId, [...(map.get(a.messageId) ?? []), a]);
    }
    return map;
  }

  /** Drops one of the person's pending uploads (chip removed before sending). */
  discard(personId: string, id: string): boolean {
    const row = this.#db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.personId, personId), isNull(attachments.conversationId)))
      .get();
    if (row === undefined) return false;
    this.#db.delete(attachments).where(eq(attachments.id, id)).run();
    rmSync(this.#pendingPath(row), { force: true });
    return true;
  }

  /** Files of a deleted conversation (its rows went with it). */
  removeConversationFiles(conversationId: string): void {
    rmSync(this.dirOf(conversationId), { recursive: true, force: true });
  }

  /** Pending uploads older than a day: rows and files. Returns how many. */
  purgePending(): number {
    const expired = this.#db
      .select()
      .from(attachments)
      .where(and(isNull(attachments.conversationId), lt(attachments.createdAt, this.#clock() - PENDING_TTL_MS)))
      .all();
    for (const a of expired) {
      this.#db.delete(attachments).where(eq(attachments.id, a.id)).run();
      rmSync(this.#pendingPath(a), { force: true });
    }
    return expired.length;
  }

  #pendingPath(a: Pick<Attachment, "id" | "extension">): string {
    return join(this.#root, PENDING_DIR, fileName(a));
  }
}
