import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AttachmentStore, cleanName, PENDING_TTL_MS, toSummary } from "../src/attachments/store.ts";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { createTempDir, createTestClock, createTestDb, PDF_BYTES, PNG_BYTES } from "./helpers.ts";

function setup() {
  const db = createTestDb();
  const time = createTestClock();
  const root = createTempDir();
  const store = new AttachmentStore(db, root, time.clock);
  const repository = new ConversationRepository(db, time.clock);
  /** A conversation of `personId` with one user message, ready to receive attachments. */
  const conversation = (personId = "kevin") => {
    const c = repository.create(personId, "Factures");
    return { conversationId: c.id, messageId: repository.addMessage(c.id, "user", "Regarde") };
  };
  return { db, time, root, store, repository, conversation };
}

function stored(store: AttachmentStore, personId: string, name: string, bytes: Uint8Array = PDF_BYTES) {
  const result = store.upload(personId, name, bytes);
  if (result.status !== "stored") throw new Error(`refused: ${result.reason}`);
  return result.attachment;
}

describe("cleanName", () => {
  test("keeps the last path segment, NFC, without control characters, at most 200 characters", () => {
    expect(cleanName("..\\..\\C:\\Windows\\Facture été.PDF")).toBe("Facture été.PDF");
    expect(cleanName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(cleanName("e\u0301te\u0301\u0000\u202e.pdf")).toBe("été.pdf");
    const long = cleanName(`${"a".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("AttachmentStore", () => {
  test("an upload is stored pending, under a generated name", () => {
    const { store, root } = setup();
    const a = stored(store, "kevin", "../Facture été.PDF");
    expect(a).toMatchObject({
      personId: "kevin", conversationId: null, messageId: null, name: "Facture été.PDF", kind: "pdf", extension: ".pdf",
      size: PDF_BYTES.byteLength,
    });
    expect(readFileSync(join(root, "pending", `${a.id}.pdf`))).toEqual(Buffer.from(PDF_BYTES));
    expect(toSummary(a)).toEqual({ id: a.id, name: "Facture été.PDF", kind: "pdf", size: PDF_BYTES.byteLength });
  });

  test.each([
    ["virus.exe", PDF_BYTES, "unsupported"],
    ["vide.pdf", new Uint8Array(0), "empty"],
    ["deguise.pdf", PNG_BYTES, "unsupported"],
    ["../", PDF_BYTES, "unsupported"],
  ] as const)("%s is refused (%s)", (name, bytes, reason) => {
    expect(setup().store.upload("kevin", name, bytes)).toEqual({ status: "refused", reason });
  });

  test("over 25 MB is refused", () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(PDF_BYTES);
    expect(setup().store.upload("kevin", "gros.pdf", big)).toEqual({ status: "refused", reason: "too_large" });
  });

  test("pending: only the person's own, unsent, recent uploads, all or nothing, in order", () => {
    const { store, time } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const b = stored(store, "kevin", "b.png", PNG_BYTES);
    const theirs = stored(store, "elodie", "c.pdf");
    expect(store.pending("kevin", [])).toEqual([]);
    expect(store.pending("kevin", [b.id, a.id])?.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(store.pending("kevin", [a.id, theirs.id])).toBeUndefined();
    expect(store.pending("elodie", [a.id])).toBeUndefined();
    expect(store.pending("kevin", [a.id, a.id])).toBeUndefined();
    time.advance(PENDING_TTL_MS + 1);
    expect(store.pending("kevin", [a.id])).toBeUndefined();
  });

  test("claim moves the files into the conversation; only that conversation reaches them", () => {
    const { store, conversation, root } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const mine = conversation();
    const other = conversation();
    const [claimed] = store.claim(store.pending("kevin", [a.id]) ?? [], mine.conversationId, mine.messageId);
    expect(claimed).toMatchObject({ conversationId: mine.conversationId, messageId: mine.messageId });
    expect(existsSync(join(root, "pending", `${a.id}.pdf`))).toBe(false);
    const found = store.pathOf(mine.conversationId, a.id);
    expect(found?.path).toBe(join(root, mine.conversationId, `${a.id}.pdf`));
    expect(existsSync(found?.path ?? "")).toBe(true);
    expect(store.pathOf(other.conversationId, a.id)).toBeUndefined();
    expect(store.pending("kevin", [a.id])).toBeUndefined();
    expect(store.readableDirs(mine.conversationId)).toEqual([join(root, mine.conversationId)]);
    expect(store.readableDirs(other.conversationId)).toEqual([]);
    expect(store.byMessage(mine.conversationId).get(mine.messageId)?.map((x) => x.id)).toEqual([a.id]);
  });

  test("discard: own pending upload only", () => {
    const { store, conversation, root } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const b = stored(store, "kevin", "b.pdf");
    expect(store.discard("elodie", a.id)).toBe(false);
    expect(store.discard("kevin", a.id)).toBe(true);
    expect(existsSync(join(root, "pending", `${a.id}.pdf`))).toBe(false);
    const c = conversation();
    store.claim(store.pending("kevin", [b.id]) ?? [], c.conversationId, c.messageId);
    expect(store.discard("kevin", b.id)).toBe(false);
  });

  test("purgePending drops uploads older than a day, rows and files", () => {
    const { store, time, root } = setup();
    const old = stored(store, "kevin", "vieux.pdf");
    time.advance(PENDING_TTL_MS + 1);
    const fresh = stored(store, "kevin", "neuf.pdf");
    expect(store.purgePending()).toBe(1);
    expect(existsSync(join(root, "pending", `${old.id}.pdf`))).toBe(false);
    expect(store.pending("kevin", [fresh.id])).toHaveLength(1);
  });

  test("deleting the conversation drops its attachment rows; removeConversationFiles drops the folder", () => {
    const { store, repository, conversation, root } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const c = conversation();
    store.claim(store.pending("kevin", [a.id]) ?? [], c.conversationId, c.messageId);
    expect(repository.delete(c.conversationId, "kevin")).toBe(true);
    expect(store.pathOf(c.conversationId, a.id)).toBeUndefined();
    store.removeConversationFiles(c.conversationId);
    expect(existsSync(join(root, c.conversationId))).toBe(false);
  });

  test("a conversation id that is not a UUID never becomes a path", () => {
    expect(() => setup().store.dirOf("../../etc")).toThrow();
  });
});
