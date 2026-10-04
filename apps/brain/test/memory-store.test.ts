import { describe, expect, test } from "vitest";
import { type Embedder, normalize } from "../src/memory/embedder.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createTestClock, createTestDb } from "./helpers.ts";

function setup() {
  const db = createTestDb();
  const time = createTestClock();
  const store = new MemoryStore(db, new FakeEmbedder(), time.clock, { duplicateThreshold: 0.95, minSimilarity: 0.3 });
  return { db, time, store };
}

/** Maps every text to the same vector: any two texts are identical to it (similarity 1). */
function constantEmbedder(model: string): Embedder {
  return {
    model,
    dimensions: 4,
    embed: (texts) => Promise.resolve(texts.map(() => normalize(new Float32Array([1, 1, 0, 0])))),
  };
}

const remember = (store: MemoryStore, personId: string, text: string, scope: "common" | "personal" = "personal") =>
  store.remember({ personId, scope, kind: "preference", text, source: "conversation" });

describe("MemoryStore", () => {
  test("remember then search finds it, and counts the recall", async () => {
    const { store } = setup();
    const created = await remember(store, "kevin", "Kévin adore les lasagnes");
    expect(created.status).toBe("created");
    const found = await store.search("kevin", "lasagnes");
    expect(found.map((m) => m.text)).toEqual(["Kévin adore les lasagnes"]);
    expect(found[0]?.recallCount).toBe(1);
  });

  test("cloisonnement: Élodie never sees, finds, edits or forgets Kévin's personal memories", async () => {
    const { store } = setup();
    const result = await remember(store, "kevin", "Kévin prépare une surprise pour Élodie");
    if (result.status !== "created") throw new Error("not created");
    const id = result.memory.id;
    expect(await store.search("elodie", "surprise")).toEqual([]);
    expect(store.list("elodie", {})).toEqual([]);
    expect(store.get("elodie", id)).toBeUndefined();
    expect(await store.update("elodie", id, { text: "piraté" })).toBeUndefined();
    expect(store.forget("elodie", id)).toBe(false);
    expect(store.get("kevin", id)?.text).toBe("Kévin prépare une surprise pour Élodie");
  });

  test("common memories are shared", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Le chauffe-eau se lance en heures creuses", "common");
    expect((await store.search("elodie", "chauffe-eau")).map((m) => m.scope)).toEqual(["common"]);
  });

  test("near-duplicate in the same scope is not stored twice", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    const again = await remember(store, "kevin", "kévin adore les LASAGNES !");
    expect(again.status).toBe("duplicate");
    expect(store.list("kevin", {})).toHaveLength(1);
  });

  test("refuses passwords and codes", async () => {
    const { store } = setup();
    expect((await remember(store, "kevin", "Le mot de passe du wifi est hunter2")).status).toBe("refused");
    expect((await remember(store, "kevin", "Code PIN de la carte : 1234")).status).toBe("refused");
  });

  test("update text re-embeds and moves scope (common ↔ own personal only)", async () => {
    const { store } = setup();
    const result = await remember(store, "kevin", "Élodie aime le thé vert", "common");
    if (result.status !== "created") throw new Error("not created");
    const updated = await store.update("kevin", result.memory.id, { text: "Kévin aime le thé vert", scope: "personal" });
    expect(updated?.scope).toBe("kevin");
    expect((await store.search("kevin", "thé vert")).map((m) => m.text)).toEqual(["Kévin aime le thé vert"]);
    expect(await store.search("elodie", "thé vert")).toEqual([]);
  });

  test("forget is soft, purge removes after 30 days", async () => {
    const { store, time } = setup();
    const result = await remember(store, "kevin", "Rendez-vous chez le dentiste mardi");
    if (result.status !== "created") throw new Error("not created");
    expect(store.forget("kevin", result.memory.id)).toBe(true);
    expect(await store.search("kevin", "dentiste")).toEqual([]);
    expect(store.purgeForgotten()).toBe(0);
    time.advance(31 * 24 * 3_600_000);
    expect(store.purgeForgotten()).toBe(1);
  });

  test("unrelated query returns nothing (similarity floor)", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    expect(await store.search("kevin", "météo demain")).toEqual([]);
  });

  test("vectors from another embedding model are never compared (search and dedupe)", async () => {
    const db = createTestDb();
    const { clock } = createTestClock();
    const older = new MemoryStore(db, constantEmbedder("old-model"), clock);
    const current = new MemoryStore(db, constantEmbedder("new-model"), clock);
    expect((await remember(older, "kevin", "Kévin adore les lasagnes")).status).toBe("created");

    // Same model: every vector is identical, so anything matches and everything is a duplicate.
    expect((await older.search("kevin", "météo demain")).map((m) => m.text)).toEqual(["Kévin adore les lasagnes"]);
    expect((await remember(older, "kevin", "Rien à voir")).status).toBe("duplicate");

    // Another model: the old vector is ignored...
    expect(await current.search("kevin", "météo demain")).toEqual([]);
    expect((await remember(current, "kevin", "Rien à voir")).status).toBe("created");
    // ...but full text still finds the old memory.
    expect((await current.search("kevin", "lasagnes")).map((m) => m.text)).toContain("Kévin adore les lasagnes");
  });

  test("pinned and rules for the sheet", async () => {
    const { store } = setup();
    await store.remember({ personId: "kevin", scope: "common", kind: "rule", text: "On ne chauffe pas au-delà de 20 °C", source: "manual" });
    await store.remember({ personId: "kevin", scope: "personal", kind: "fact", text: "Kévin est allergique aux noix", source: "manual", pinned: true });
    await remember(store, "elodie", "Élodie déteste le coriandre");
    const sheet = store.sheetMemories("kevin");
    expect(sheet.rules.map((m) => m.text)).toEqual(["On ne chauffe pas au-delà de 20 °C"]);
    expect(sheet.pinnedPersonal.map((m) => m.text)).toEqual(["Kévin est allergique aux noix"]);
    expect(sheet.pinnedCommon).toEqual([]);
  });
});
