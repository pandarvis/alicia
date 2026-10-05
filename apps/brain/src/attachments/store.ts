import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AttachmentRefusalReason, type AttachmentSummary, checkAttachment } from "@alicia/protocol";
import { and, asc, count, eq, gte, inArray, isNull, lt, sql, sum, TransactionRollbackError } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/open.ts";
import { attachments, conversations } from "../db/schema.ts";
import { contentMatches } from "./sniff.ts";

export type Attachment = typeof attachments.$inferSelect;
export type UploadResult =
  | { status: "stored"; attachment: Attachment }
  | { status: "refused"; reason: AttachmentRefusalReason };
/**
 * "gone": an id is unknown, someone else's, already sent, expired or repeated (nothing is claimed); "failed": a
 * file could not be moved (everything is put back, still pending).
 */
export type ClaimResult = { status: "claimed"; attachments: Attachment[] } | { status: "gone" } | { status: "failed" };

/** An upload not sent in a message within a day is dropped. */
export const PENDING_TTL_MS = 24 * 3_600_000;
/** What one person may leave waiting (uploaded, not sent yet). */
export const PENDING_MAX_FILES = 20;
export const PENDING_MAX_BYTES = 250 * 1024 * 1024;
const PENDING_DIR = "pending";
const NAME_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Moving a file may meet a lock (antivirus, indexer on Windows): it is tried again a few times. */
const MOVE_ATTEMPTS = 3;
const MOVE_RETRY_MS = 50;
const RETRIABLE = new Set(["EBUSY", "EPERM", "EACCES"]);
/**
 * Characters that can disguise a name: controls, and every invisible format character (direction overrides and
 * marks, zero-width spaces…) but the joiners (ZWNJ, ZWJ: emoji and some scripts need them) and the emoji tag
 * characters (subdivision flags).
 */
const DISGUISE = /[[\p{Cc}\p{Cf}]--[\u200C\u200D\u{E0020}-\u{E007F}]]/gv;
/** Line and paragraph separators: a name stays on one line. */
const LINE_BREAKS = /[\u0085\p{Zl}\p{Zp}]/gu;
const graphemes = new Intl.Segmenter("fr", { granularity: "grapheme" });

/**
 * Display name: last path segment, well-formed, NFC, without control or disguising characters, at most 200
 * characters, cut between graphemes (the extension is kept).
 */
export function cleanName(raw: string): string {
  const base = raw.toWellFormed().split(/[\\/]/u).at(-1) ?? "";
  const clean = base.normalize("NFC").replace(LINE_BREAKS, " ").replace(DISGUISE, "").trim();
  if (clean.length <= NAME_MAX) return clean;
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? clean.slice(dot) : "";
  let kept = "";
  for (const { segment } of graphemes.segment(clean.slice(0, clean.length - extension.length))) {
    if (kept.length + segment.length + extension.length > NAME_MAX) break;
    kept += segment;
  }
  return `${kept}${extension}`;
}

const fileName = (a: Pick<Attachment, "id" | "extension">): string => `${a.id}${a.extension}`;

export function toSummary(a: Attachment): AttachmentSummary {
  return { id: a.id, name: a.name, kind: a.kind, size: a.size };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** Moves a file, trying again when it is briefly locked. */
async function move(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
      if (attempt >= MOVE_ATTEMPTS || typeof code !== "string" || !RETRIABLE.has(code)) throw error;
      await pause(MOVE_RETRY_MS * attempt);
    }
  }
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
    // Absolute whatever the config says (`./data` by default): its paths go to Alicia and to the SDK, whose
    // working directory is the workspace.
    this.#root = resolve(root);
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
    if (!this.#roomFor(personId, bytes.byteLength)) return { status: "refused", reason: "too_many" };
    const attachment: Attachment = {
      id: randomUUID(), personId, conversationId: null, messageId: null, name,
      kind: check.type.kind, extension: check.type.extension, size: bytes.byteLength, createdAt: this.#clock(),
    };
    mkdirSync(join(this.#root, PENDING_DIR), { recursive: true });
    const path = this.#pendingPath(attachment);
    // Created here or not at all ("wx"); a write that fails half-way leaves nothing behind.
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, bytes);
    } catch (error) {
      closeSync(fd);
      rmSync(path, { force: true });
      throw error;
    }
    closeSync(fd);
    try {
      this.#db.insert(attachments).values(attachment).run();
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    return { status: "stored", attachment };
  }

  /**
   * The person's pending uploads with these ids, in this order; undefined if any is unknown, someone else's, sent,
   * expired or repeated. A check only: `claim` decides, atomically.
   */
  pending(personId: string, ids: readonly string[]): Attachment[] | undefined {
    if (ids.length === 0) return [];
    if (new Set(ids).size !== ids.length) return undefined;
    const rows = this.#db.select().from(attachments).where(this.#ownPending(personId, ids)).all();
    const ordered = ids.map((id) => rows.find((r) => r.id === id));
    return ordered.every((a): a is Attachment => a !== undefined) ? ordered : undefined;
  }

  /**
   * Moves the person's pending uploads into the conversation, linked to the user message carrying them: all of
   * them or none. Ownership is checked here, by the very statement that takes them: nobody else's upload, and an
   * upload is never claimed twice, even by two messages at once.
   */
  async claim(personId: string, ids: readonly string[], conversationId: string, messageId: string): Promise<ClaimResult> {
    if (ids.length === 0 || new Set(ids).size !== ids.length) return { status: "gone" };
    const dir = this.dirOf(conversationId);
    const taken = this.#take(personId, ids, conversationId, messageId);
    if (taken === undefined) return { status: "gone" };
    const moved: Attachment[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      for (const a of taken) {
        await move(this.#pendingPath(a), join(dir, fileName(a)));
        moved.push(a);
      }
    } catch {
      // Everything goes back as it was: the files in pending/, the rows pending again.
      for (const a of moved) {
        try {
          renameSync(join(dir, fileName(a)), this.#pendingPath(a));
        } catch {
          // Stays in the conversation's folder; its row is pending all the same, and purged after a day.
        }
      }
      this.#db
        .update(attachments)
        .set({ conversationId: null, messageId: null })
        .where(and(inArray(attachments.id, [...ids]), eq(attachments.personId, personId)))
        .run();
      return { status: "failed" };
    }
    return { status: "claimed", attachments: taken.map((a) => ({ ...a, conversationId, messageId })) };
  }

  /** An attachment of this person in this conversation, and its file; undefined for anything else. */
  pathOf(personId: string, conversationId: string, id: string): { attachment: Attachment; path: string } | undefined {
    const attachment = this.#db
      .select()
      .from(attachments)
      .where(and(
        eq(attachments.id, id), eq(attachments.conversationId, conversationId), eq(attachments.personId, personId),
      ))
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

  /**
   * Conversation folders left behind by a deletion whose file removal failed (crash, locked file): removed at
   * startup. Only UUID-named folders without a conversation row; returns how many.
   */
  sweepOrphanFolders(): number {
    if (!existsSync(this.#root)) return 0;
    let removed = 0;
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const row = this.#db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, entry.name)).get();
      if (row !== undefined) continue;
      rmSync(join(this.#root, entry.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
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

  /** The person's own uploads among `ids`, not sent yet, not expired. */
  #ownPending(personId: string, ids: readonly string[]) {
    return and(
      inArray(attachments.id, [...ids]),
      eq(attachments.personId, personId),
      isNull(attachments.conversationId),
      gte(attachments.createdAt, this.#clock() - PENDING_TTL_MS),
    );
  }

  /** Takes the rows for the conversation, all in one transaction; undefined (nothing taken) if any is missing. */
  #take(personId: string, ids: readonly string[], conversationId: string, messageId: string): Attachment[] | undefined {
    try {
      return this.#db.transaction((tx) => {
        const owned = this.#ownPending(personId, ids);
        const rows = tx.select().from(attachments).where(owned).all();
        const result = tx.update(attachments).set({ conversationId, messageId }).where(owned).run();
        if (rows.length !== ids.length || result.changes !== ids.length) tx.rollback();
        return ids.map((id) => rows.find((row) => row.id === id)).filter((a): a is Attachment => a !== undefined);
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) return undefined;
      throw error;
    }
  }

  /** Whether the person may leave one more file of this size waiting. */
  #roomFor(personId: string, size: number): boolean {
    const waiting = this.#db
      .select({ files: count(), bytes: sum(attachments.size).mapWith(Number) })
      .from(attachments)
      .where(and(
        eq(attachments.personId, personId),
        isNull(attachments.conversationId),
        gte(attachments.createdAt, this.#clock() - PENDING_TTL_MS),
      ))
      .get();
    return (waiting?.files ?? 0) < PENDING_MAX_FILES && (waiting?.bytes ?? 0) + size <= PENDING_MAX_BYTES;
  }

  #pendingPath(a: Pick<Attachment, "id" | "extension">): string {
    return join(this.#root, PENDING_DIR, fileName(a));
  }
}
