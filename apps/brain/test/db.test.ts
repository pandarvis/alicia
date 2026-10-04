import { describe, expect, test } from "vitest";
import { openDb } from "../src/db/open.ts";
import { people } from "../src/db/schema.ts";

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

/** SQLite's plan for a query, one line per step. */
function plan(db: ReturnType<typeof openDb>, query: string, ...params: readonly unknown[]): string {
  return db.$client
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all(...params)
    .map((row) => (row as { detail: string }).detail)
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
    expect(plan(openDb(":memory:"), query, ...params)).toContain(index);
  });
});
