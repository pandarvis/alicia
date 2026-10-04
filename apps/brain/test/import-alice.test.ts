import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { importAlice, readAliceMemories, readAliceRules } from "../src/memory/import-alice.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createTestClock, createTestDb } from "./helpers.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

/** Minimal copy of the Chroma tables the importer reads. */
function fakeChroma(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE embeddings (id INTEGER PRIMARY KEY, segment_id TEXT, embedding_id TEXT, seq_id BLOB, created_at TEXT);
           CREATE TABLE embedding_metadata (id INTEGER, key TEXT, string_value TEXT, int_value INTEGER, float_value REAL, bool_value INTEGER);`);
  const meta = db.prepare("INSERT INTO embedding_metadata (id, key, string_value, int_value, bool_value) VALUES (?, ?, ?, ?, ?)");
  db.prepare("INSERT INTO embeddings (id, segment_id, embedding_id) VALUES (1, 's', 'e-1'), (2, 's', 'e-2')").run();
  meta.run(1, "chroma:document", "Le chat s'appelle Moka", null, null);
  meta.run(1, "created", null, 1_783_852_500, null);
  meta.run(1, "hits", null, 6, null);
  meta.run(1, "last_recalled", null, 1_784_073_972, null);
  meta.run(1, "pinned", null, null, 1);
  meta.run(1, "source", "user", null, null);
  meta.run(2, "chroma:document", "Kévin aime le café serré", null, null);
  meta.run(2, "created", null, 1_783_900_000, null);
  meta.run(2, "hits", null, 0, null);
  meta.run(2, "pinned", null, null, 0);
  meta.run(2, "source", "inferred", null, null);
  db.close();
}

function newStore(): MemoryStore {
  return new MemoryStore(createTestDb(), new FakeEmbedder(), createTestClock().clock, { duplicateThreshold: 0.95, minSimilarity: 0.3 });
}

describe("import from the old Alice", () => {
  test("reads memories and rules", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-import-"));
    const chroma = join(dir, "chroma.sqlite3");
    fakeChroma(chroma);
    expect(readAliceMemories(chroma)).toEqual([
      { key: "alice:chroma:e-1", text: "Le chat s'appelle Moka", pinned: true, createdAt: 1_783_852_500_000, recallCount: 6, lastRecalledAt: 1_784_073_972_000 },
      { key: "alice:chroma:e-2", text: "Kévin aime le café serré", pinned: false, createdAt: 1_783_900_000_000, recallCount: 0, lastRecalledAt: null },
    ]);
    const rules = join(dir, "regles.json");
    writeFileSync(rules, JSON.stringify({ regles: [{ id: "a1b2c", texte: "Pas plus de 20 °C", cree_le: "2026-07-22T10:00:00", par: "pwa" }] }));
    expect(readAliceRules(rules)).toEqual([{ key: "alice:rule:a1b2c", text: "Pas plus de 20 °C", createdAt: Date.parse("2026-07-22T10:00:00") }]);
  });

  test("imports into common, idempotently", async () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-import-"));
    const chroma = join(dir, "chroma.sqlite3");
    fakeChroma(chroma);
    const store = newStore();
    const source = { memories: readAliceMemories(chroma), rules: [{ key: "alice:rule:x", text: "Pas plus de 20 °C", createdAt: 0 }] };
    expect(await importAlice(store, source)).toEqual({ created: 3, duplicates: 0, skipped: 0, refused: 0 });
    expect(await importAlice(store, source)).toEqual({ created: 0, duplicates: 0, skipped: 3, refused: 0 });
    const all = store.list("elodie", {});
    expect(all.every((m) => m.scope === "common")).toBe(true);
    expect(all.find((m) => m.text === "Pas plus de 20 °C")).toMatchObject({ kind: "rule", pinned: true });
    expect(all.find((m) => m.text === "Le chat s'appelle Moka")).toMatchObject({ kind: "fact", pinned: true, recallCount: 6 });
  });

  test("refuses an old memory that holds a secret, and counts it", async () => {
    const store = newStore();
    const base = { pinned: false, createdAt: 1_000, recallCount: 0, lastRecalledAt: null };
    const source = {
      memories: [
        { ...base, key: "alice:chroma:s-1", text: "Le mot de passe du wifi est secret123" },
        { ...base, key: "alice:chroma:s-2", text: "Le chat s'appelle Moka" },
      ],
      rules: [],
    };
    expect(await importAlice(store, source)).toEqual({ created: 1, duplicates: 0, skipped: 0, refused: 1 });
    expect(store.list("kevin", {}).map((m) => m.text)).toEqual(["Le chat s'appelle Moka"]);
  });

  test("counts a duplicate of a memory stored just before", async () => {
    const store = newStore();
    const base = { pinned: false, createdAt: 1_000, recallCount: 0, lastRecalledAt: null };
    const source = {
      memories: [
        { ...base, key: "alice:chroma:d-1", text: "Le chat s'appelle Moka" },
        { ...base, key: "alice:chroma:d-2", text: "Le chat s'appelle Moka" },
      ],
      rules: [],
    };
    expect(await importAlice(store, source)).toEqual({ created: 1, duplicates: 1, skipped: 0, refused: 0 });
  });

  test("falls back to the given time when a creation date is missing or invalid", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-import-"));
    const chroma = join(dir, "chroma.sqlite3");
    const db = new Database(chroma);
    db.exec(`CREATE TABLE embeddings (id INTEGER PRIMARY KEY, segment_id TEXT, embedding_id TEXT, seq_id BLOB, created_at TEXT);
             CREATE TABLE embedding_metadata (id INTEGER, key TEXT, string_value TEXT, int_value INTEGER, float_value REAL, bool_value INTEGER);
             INSERT INTO embeddings (id, segment_id, embedding_id) VALUES (1, 's', 'e-1');
             INSERT INTO embedding_metadata (id, key, string_value) VALUES (1, 'chroma:document', 'Sans date');`);
    db.close();
    expect(readAliceMemories(chroma, 5_000)).toEqual([
      { key: "alice:chroma:e-1", text: "Sans date", pinned: false, createdAt: 5_000, recallCount: 0, lastRecalledAt: null },
    ]);
    const rules = join(dir, "regles.json");
    writeFileSync(rules, JSON.stringify({ regles: [{ id: "z9", texte: "Règle", cree_le: "pas une date" }] }));
    expect(readAliceRules(rules, 7_000)).toEqual([{ key: "alice:rule:z9", text: "Règle", createdAt: 7_000 }]);
  });

  test("skips and counts a text longer than the 1000 characters the API allows", async () => {
    const store = newStore();
    const base = { pinned: false, createdAt: 1_000, recallCount: 0, lastRecalledAt: null };
    const source = {
      memories: [
        { ...base, key: "alice:chroma:l-1", text: "a".repeat(1001) },
        { ...base, key: "alice:chroma:l-2", text: "b".repeat(1000) },
      ],
      rules: [],
    };
    expect(await importAlice(store, source)).toEqual({ created: 1, duplicates: 0, skipped: 0, refused: 1 });
    expect(store.list("kevin", {}).map((m) => m.text.length)).toEqual([1000]);
  });

  test("reads a temporary copy: the source folder gains no file, even in WAL mode", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-import-"));
    const chroma = join(dir, "chroma.sqlite3");
    const db = new Database(chroma);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec(`CREATE TABLE embeddings (id INTEGER PRIMARY KEY, segment_id TEXT, embedding_id TEXT, seq_id BLOB, created_at TEXT);
             CREATE TABLE embedding_metadata (id INTEGER, key TEXT, string_value TEXT, int_value INTEGER, float_value REAL, bool_value INTEGER);
             INSERT INTO embeddings (id, segment_id, embedding_id) VALUES (1, 's', 'e-1');
             INSERT INTO embedding_metadata (id, key, string_value) VALUES (1, 'chroma:document', 'Encore dans le WAL');`);
    // The writer stays open: the row only lives in the -wal file.
    const before = readdirSync(dir).sort();
    expect(before).toContain("chroma.sqlite3-wal");
    expect(readAliceMemories(chroma, 1).map((m) => m.text)).toEqual(["Encore dans le WAL"]);
    expect(readdirSync(dir).sort()).toEqual(before);
    db.close();
    // Closing the writer checkpoints and removes the siblings: reading afterwards still leaves nothing behind.
    const after = readdirSync(dir).sort();
    readAliceMemories(chroma, 1);
    expect(readdirSync(dir).sort()).toEqual(after);
  });
});
