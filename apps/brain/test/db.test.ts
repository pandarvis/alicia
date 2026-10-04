import { expect, test } from "vitest";
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
