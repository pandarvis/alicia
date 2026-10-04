import type { Person } from "@alicia/protocol";
import { openDb } from "../src/db/open.ts";
import { syncPeople } from "../src/identity/people.ts";

export const KEVIN: Person = { id: "kevin", name: "Kévin" };
export const ELODIE: Person = { id: "elodie", name: "Élodie" };

/** Test clock: advanced by hand. */
export function createTestClock(start = Date.UTC(2026, 9, 4, 13, 30)) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** In-memory database with Kévin and Élodie. */
export function createTestDb() {
  const db = openDb(":memory:");
  syncPeople(db, [KEVIN, ELODIE]);
  return db;
}
