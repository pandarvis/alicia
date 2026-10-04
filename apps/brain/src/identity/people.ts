import type { Person } from "@alicia/protocol";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { people } from "../db/schema.ts";

/** Creates or renames the people declared in the config. Never deletes. */
export function syncPeople(db: Db, list: readonly Person[]): void {
  for (const p of list) {
    db
      .insert(people)
      .values(p)
      .onConflictDoUpdate({ target: people.id, set: { name: p.name } })
      .run();
  }
}

export function findPerson(db: Db, id: string): Person | undefined {
  return db.select().from(people).where(eq(people.id, id)).get();
}
