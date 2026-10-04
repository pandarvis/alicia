import type { Person } from "@alicia/protocol";
import type { Clock } from "../src/clock.ts";
import { type Db, openDb } from "../src/db/open.ts";
import { syncPeople } from "../src/identity/people.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { MemoryStore } from "../src/memory/store.ts";

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

/** Memory store with the deterministic embedder (never downloads a model). */
export function createTestMemory(db: Db, clock: Clock) {
  return new MemoryStore(db, new FakeEmbedder(), clock, { duplicateThreshold: 0.95, minSimilarity: 0.3 });
}
