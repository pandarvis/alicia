import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { openDb } from "../src/db/open.ts";
import { people } from "../src/db/schema.ts";
import { createTempDir } from "./helpers.ts";

const Journal = z.looseObject({ entries: z.array(z.looseObject({ idx: z.number() })) });

test("opens an in-memory database with the migrated tables", () => {
  const db = openDb(":memory:");
  db.insert(people).values({ id: "kevin", name: "Kévin" }).run();
  expect(db.select().from(people).all()).toEqual([{ id: "kevin", name: "Kévin" }]);
});

test("foreign keys are enforced", () => {
  const db = openDb(":memory:");
  expect(() =>
    db.$client
      .prepare("INSERT INTO conversations (id, person_id, title, created_at, updated_at) VALUES ('c', 'nobody', 't', 0, 0)")
      .run(),
  ).toThrow(/FOREIGN KEY/);
});

const PlanRow = z.object({ detail: z.string() });

/** SQLite's plan for a query, one line per step. */
function plan(db: ReturnType<typeof openDb>, query: string, ...params: readonly unknown[]): string {
  return db.$client
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all(...params)
    .map((row) => PlanRow.parse(row).detail)
    .join("\n");
}

describe("hot queries use an index", () => {
  test.each([
    ["conversations of a person, most recent first",
      "SELECT id FROM conversations WHERE person_id = ? ORDER BY updated_at DESC", ["kevin"], "conversations_person_updated_idx"],
    ["messages of a conversation, in order",
      "SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at", ["c"], "messages_conversation_created_idx"],
    ["device by token hash", "SELECT id FROM devices WHERE token_hash = ?", ["h"], "devices_token_hash_unique"],
    ["memories in reach", "SELECT id FROM memories WHERE scope = ? AND forgotten_at IS NULL", ["kevin"], "memories_scope_idx"],
    ["memories of a deleted conversation (ON DELETE SET NULL)",
      "SELECT id FROM memories WHERE conversation_id = ?", ["c"], "memories_conversation_idx"],
    ["turn log of a deleted conversation", "SELECT id FROM turn_log WHERE conversation_id = ?", ["c"], "turn_log_conversation_idx"],
    ["turn log rotation", "SELECT id FROM turn_log WHERE created_at < ?", [0], "turn_log_created_idx"],
  ] as const)("%s", (_label, query, params, index) => {
    const db = openDb(":memory:");
    try {
      expect(plan(db, query, ...params)).toContain(index);
    } finally {
      db.$client.close();
    }
  });
});

test("migration 0005: conversations that already let outside content in start untrusted", () => {
  const source = fileURLToPath(new URL("../drizzle", import.meta.url));
  // The migrations as they stood before 0005, applied to a file database holding older conversations.
  const folder = createTempDir();
  cpSync(source, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = Journal.parse(JSON.parse(readFileSync(journalPath, "utf8")));
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 4) }));
  const path = join(createTempDir(), "old.db");
  const sqlite = new Database(path);
  migrate(drizzle({ client: sqlite }), { migrationsFolder: folder });
  sqlite.exec(`
    INSERT INTO people (id, name) VALUES ('kevin', 'Kévin');
    INSERT INTO conversations (id, person_id, title, created_at, updated_at) VALUES
      ('attached', 'kevin', 't', 1, 1), ('fetched', 'kevin', 't', 2, 2), ('searched', 'kevin', 't', 3, 3), ('plain', 'kevin', 't', 4, 4);
    INSERT INTO attachments (id, person_id, conversation_id, name, kind, extension, size, created_at)
      VALUES ('a1', 'kevin', 'attached', 'f.pdf', 'pdf', '.pdf', 1, 10), ('a2', 'kevin', NULL, 'g.pdf', 'pdf', '.pdf', 1, 10);
    INSERT INTO turn_log (id, conversation_id, model, input_tokens, output_tokens, duration_ms, tools, created_at) VALUES
      ('t1', 'fetched', 'sonnet', 0, 0, 0, '[{"callId":"c","tool":"WebFetch","success":true}]', 20),
      ('t2', 'searched', 'sonnet', 0, 0, 0, '[{"callId":"c","tool":"WebSearch","success":true}]', 30),
      ('t3', 'plain', 'sonnet', 0, 0, 0, '[{"callId":"c","tool":"memory_search","success":true}]', 40);
  `);
  sqlite.close();
  const db = openDb(path);
  const rows = db.$client.prepare("SELECT id, untrusted_at AS untrustedAt FROM conversations ORDER BY created_at").all();
  db.$client.close();
  expect(rows).toEqual([
    { id: "attached", untrustedAt: 1 }, { id: "fetched", untrustedAt: 2 }, { id: "searched", untrustedAt: 3 }, { id: "plain", untrustedAt: null },
  ]);
});
