import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

describe("cleanName keeps what the person sees", () => {
  test("emoji sequences (ZWJ, variation selectors) survive; direction tricks do not", () => {
    expect(cleanName("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} famille \u2764\uFE0F.pdf")).toBe("👨‍👩‍👧 famille ❤️.pdf");
    expect(cleanName("fac\u200eture\u2066gpj.exe\u2069\u061c\u200f.pdf")).toBe("facturegpj.exe.pdf");
  });

  test("line and paragraph separators become spaces: a name stays on one line", () => {
    expect(cleanName("a b c\u0085d.pdf")).toBe("a b c d.pdf");
  });

  test("a long name is cut between graphemes, never inside one, and stays well-formed", () => {
    const family = "👨‍👩‍👧";
    const long = cleanName(`${family.repeat(60)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith(`${family}.pdf`)).toBe(true);
    expect(long.isWellFormed()).toBe(true);
    expect(cleanName("a�b.txt").isWellFormed()).toBe(true);
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

  test("claim moves the files into the conversation; only that conversation reaches them", async () => {
    const { store, conversation, root } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const mine = conversation();
    const other = conversation();
    const claim = await store.claim("kevin", [a.id], mine.conversationId, mine.messageId);
    if (claim.status !== "claimed") throw new Error(claim.status);
    expect(claim.attachments[0]).toMatchObject({ conversationId: mine.conversationId, messageId: mine.messageId });
    expect(existsSync(join(root, "pending", `${a.id}.pdf`))).toBe(false);
    const found = store.pathOf("kevin", mine.conversationId, a.id);
    expect(found?.path).toBe(join(root, mine.conversationId, `${a.id}.pdf`));
    expect(existsSync(found?.path ?? "")).toBe(true);
    expect(store.pathOf("kevin", other.conversationId, a.id)).toBeUndefined();
    // Someone else never reaches it, even knowing the conversation and the id.
    expect(store.pathOf("elodie", mine.conversationId, a.id)).toBeUndefined();
    expect(store.pending("kevin", [a.id])).toBeUndefined();
    expect(store.readableDirs(mine.conversationId)).toEqual([join(root, mine.conversationId)]);
    expect(store.readableDirs(other.conversationId)).toEqual([]);
    expect(store.byMessage(mine.conversationId).get(mine.messageId)?.map((x) => x.id)).toEqual([a.id]);
  });

  test("discard: own pending upload only", async () => {
    const { store, conversation, root } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const b = stored(store, "kevin", "b.pdf");
    expect(store.discard("elodie", a.id)).toBe(false);
    expect(store.discard("kevin", a.id)).toBe(true);
    expect(existsSync(join(root, "pending", `${a.id}.pdf`))).toBe(false);
    const c = conversation();
    await store.claim("kevin", [b.id], c.conversationId, c.messageId);
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

  test("deleting the conversation drops its attachment rows; removeConversationFiles drops the folder", async () => {
    const { store, repository, conversation, root } = setup();
    const a = stored(store, "kevin", "a.pdf");
    const c = conversation();
    await store.claim("kevin", [a.id], c.conversationId, c.messageId);
    expect(repository.delete(c.conversationId, "kevin")).toBe(true);
    expect(store.pathOf("kevin", c.conversationId, a.id)).toBeUndefined();
    store.removeConversationFiles(c.conversationId);
    expect(existsSync(join(root, c.conversationId))).toBe(false);
  });

  test("the startup sweep removes conversation folders whose conversation is gone, and nothing else", async () => {
    const { store, conversation, repository, root } = setup();
    const kept = conversation();
    const gone = conversation();
    for (const c of [kept, gone]) {
      const a = stored(store, "kevin", "a.pdf");
      expect((await store.claim("kevin", [a.id], c.conversationId, c.messageId)).status).toBe("claimed");
    }
    repository.delete(gone.conversationId, "kevin");
    const pendingUpload = stored(store, "kevin", "b.pdf");
    mkdirSync(join(root, "pas-un-uuid"));
    expect(store.sweepOrphanFolders()).toBe(1);
    expect(existsSync(join(root, gone.conversationId))).toBe(false);
    expect(existsSync(join(root, kept.conversationId))).toBe(true);
    expect(existsSync(join(root, "pending", `${pendingUpload.id}.pdf`))).toBe(true);
    expect(existsSync(join(root, "pas-un-uuid"))).toBe(true);
    expect(new AttachmentStore(createTestDb(), join(root, "absent"), createTestClock().clock).sweepOrphanFolders()).toBe(0);
  });

  test("a relative root still gives absolute folders (they go to Alicia and to the SDK)", () => {
    const store = new AttachmentStore(createTestDb(), join("data", "attachments"), createTestClock().clock);
    const dir = store.dirOf("3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192");
    expect(isAbsolute(dir)).toBe(true);
    expect(dir).toBe(resolve("data", "attachments", "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192"));
  });

  test("a conversation id that is not a UUID never becomes a path", () => {
    expect(() => setup().store.dirOf("../../etc")).toThrow();
  });

  describe("claim is atomic and checks ownership itself", () => {
    const where = (path: string): boolean => existsSync(path);

    test("someone else's, unknown, sent, expired or repeated ids: nothing is claimed, nothing moves", async () => {
      const { store, conversation, root, time } = setup();
      const mine = stored(store, "kevin", "a.pdf");
      const theirs = stored(store, "elodie", "b.pdf");
      const c = conversation();
      const unknown = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";
      for (const ids of [[mine.id, theirs.id], [unknown], [mine.id, mine.id], []]) {
        expect(await store.claim("kevin", ids, c.conversationId, c.messageId)).toEqual({ status: "gone" });
      }
      expect(store.pending("kevin", [mine.id])).toHaveLength(1);
      expect(store.pending("elodie", [theirs.id])).toHaveLength(1);
      expect(where(join(root, "pending", `${theirs.id}.pdf`))).toBe(true);
      time.advance(PENDING_TTL_MS + 1);
      expect(await store.claim("kevin", [mine.id], c.conversationId, c.messageId)).toEqual({ status: "gone" });
    });

    test("two claims of the same upload at once: exactly one wins", async () => {
      const { store, conversation, root } = setup();
      const a = stored(store, "kevin", "a.pdf");
      const first = conversation();
      const second = conversation();
      const results = await Promise.all([
        store.claim("kevin", [a.id], first.conversationId, first.messageId),
        store.claim("kevin", [a.id], second.conversationId, second.messageId),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["claimed", "gone"]);
      const homes = [first, second].filter((c) => where(join(root, c.conversationId, `${a.id}.pdf`)));
      expect(homes).toHaveLength(1);
      expect(await store.claim("kevin", [a.id], first.conversationId, first.messageId)).toEqual({ status: "gone" });
    });

    test("an upload dropped between the check and the claim is not claimed", async () => {
      const { store, conversation } = setup();
      const a = stored(store, "kevin", "a.pdf");
      expect(store.pending("kevin", [a.id])).toHaveLength(1);
      expect(store.discard("kevin", a.id)).toBe(true);
      const c = conversation();
      expect(await store.claim("kevin", [a.id], c.conversationId, c.messageId)).toEqual({ status: "gone" });
    });

    test("a file that cannot be moved: the ones already moved go back, and every upload stays pending", async () => {
      const { store, conversation, root } = setup();
      const a = stored(store, "kevin", "a.pdf");
      const b = stored(store, "kevin", "b.pdf");
      const c = conversation();
      // Something already sits where the second file must go (a folder): its move fails, retries included.
      mkdirSync(join(root, c.conversationId, `${b.id}.pdf`), { recursive: true });
      expect(await store.claim("kevin", [a.id, b.id], c.conversationId, c.messageId)).toEqual({ status: "failed" });
      expect(store.pending("kevin", [a.id, b.id])).toHaveLength(2);
      expect(where(join(root, "pending", `${a.id}.pdf`))).toBe(true);
      expect(where(join(root, "pending", `${b.id}.pdf`))).toBe(true);
      expect(where(join(root, c.conversationId, `${a.id}.pdf`))).toBe(false);
      expect(store.byMessage(c.conversationId).size).toBe(0);
    });
  });

  describe("pending uploads are capped per person", () => {
    test("at most 20 files waiting: the 21st is refused, someone else is not affected", () => {
      const { store } = setup();
      for (let i = 0; i < 20; i++) stored(store, "kevin", `f${i}.pdf`);
      expect(store.upload("kevin", "encore.pdf", PDF_BYTES)).toEqual({ status: "refused", reason: "too_many" });
      expect(store.upload("elodie", "a.pdf", PDF_BYTES).status).toBe("stored");
    });

    test("at most 250 MB waiting", () => {
      const { store } = setup();
      const big = new Uint8Array(24 * 1024 * 1024);
      big.set(PDF_BYTES);
      for (let i = 0; i < 10; i++) stored(store, "kevin", `gros${i}.pdf`, big);
      expect(store.upload("kevin", "un-de-trop.pdf", big)).toEqual({ status: "refused", reason: "too_many" });
      expect(store.upload("kevin", "petit.pdf", PDF_BYTES).status).toBe("stored");
    });

    test("sent or expired uploads no longer count", async () => {
      const { store, conversation, time } = setup();
      const ids = Array.from({ length: 20 }, (_, i) => stored(store, "kevin", `f${i}.pdf`).id);
      const c = conversation();
      expect((await store.claim("kevin", ids.slice(0, 10), c.conversationId, c.messageId)).status).toBe("claimed");
      expect(store.upload("kevin", "encore.pdf", PDF_BYTES).status).toBe("stored");
      time.advance(PENDING_TTL_MS + 1);
      for (let i = 0; i < 20; i++) stored(store, "kevin", `g${i}.pdf`);
    });
  });
});
