import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { memories } from "../src/db/schema.ts";
import { createTestDb } from "./helpers.ts";

function insert(db: ReturnType<typeof createTestDb>, text: string, scope = "common") {
  const now = Date.UTC(2026, 9, 4);
  const id = randomUUID();
  db.insert(memories).values({
    id, scope, kind: "fact", text, pinned: false, source: "manual",
    embedding: Buffer.alloc(4), embeddingModel: "test", createdAt: now, updatedAt: now,
  }).run();
  return id;
}

const ftsIds = (db: ReturnType<typeof createTestDb>, match: string) =>
  db.$client
    .prepare("SELECT m.id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ?")
    .all(match)
    .map((row) => (row as { id: string }).id);

describe("memories table + FTS5", () => {
  test("full-text index follows inserts, updates and deletes", () => {
    const db = createTestDb();
    const id = insert(db, "Kévin adore les lasagnes");
    expect(ftsIds(db, "lasagnes")).toEqual([id]);
    db.$client.prepare("UPDATE memories SET text = 'Kévin adore les pizzas' WHERE id = ?").run(id);
    expect(ftsIds(db, "lasagnes")).toEqual([]);
    expect(ftsIds(db, "pizzas")).toEqual([id]);
    db.$client.prepare("DELETE FROM memories WHERE id = ?").run(id);
    expect(ftsIds(db, "pizzas")).toEqual([]);
  });

  test("accents are ignored by the full-text search", () => {
    const db = createTestDb();
    const id = insert(db, "Son plat préféré : la tartiflette");
    expect(ftsIds(db, "prefere")).toEqual([id]);
  });

  test("import_key is unique", () => {
    const db = createTestDb();
    const now = 0;
    const row = {
      scope: "common", kind: "fact" as const, text: "x", pinned: false, source: "import" as const,
      importKey: "alice:1", embedding: Buffer.alloc(4), embeddingModel: "t", createdAt: now, updatedAt: now,
    };
    db.insert(memories).values({ id: randomUUID(), ...row }).run();
    expect(() => db.insert(memories).values({ id: randomUUID(), ...row }).run()).toThrow(/UNIQUE/);
  });
});
