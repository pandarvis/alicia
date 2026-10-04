import { describe, expect, test } from "vitest";
import { type Embedder, normalize } from "../src/memory/embedder.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createTestClock, createTestDb } from "./helpers.ts";

function setup() {
  const db = createTestDb();
  const time = createTestClock();
  const store = new MemoryStore(db, new FakeEmbedder(), time.clock, { minSimilarity: 0.3 });
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

/** Fake embedder whose next calls wait until the test opens the gate. */
class GatedEmbedder implements Embedder {
  readonly #inner = new FakeEmbedder();
  readonly model = this.#inner.model;
  readonly dimensions = this.#inner.dimensions;
  gate: Promise<void> = Promise.resolve();

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    await this.gate;
    return this.#inner.embed(texts);
  }
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
    expect(await store.update("elodie", id, { text: "piraté" })).toEqual({ status: "not_found" });
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

  test("close but distinct facts are both kept (vectors can't tell them apart with e5)", async () => {
    // An embedder for which every text looks identical: only the text decides what a duplicate is.
    const sameVector: Embedder = {
      model: "same-vector", dimensions: 2,
      embed: (texts) => Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
    };
    const store = new MemoryStore(createTestDb(), sameVector, createTestClock().clock, { minSimilarity: 0.3 });
    await remember(store, "kevin", "Kévin est allergique aux noix");
    expect((await remember(store, "kevin", "Kévin est allergique aux noisettes")).status).toBe("created");
    expect((await remember(store, "kevin", "Rendez-vous chez le dentiste mardi")).status).toBe("created");
    expect((await remember(store, "kevin", "Rendez-vous chez le dentiste jeudi")).status).toBe("created");
    expect((await remember(store, "kevin", "kevin est ALLERGIQUE aux noix.")).status).toBe("duplicate");
    expect(store.list("kevin", {})).toHaveLength(4);
  });

  test.each([
    "Le mot de passe du wifi est hunter2",
    "mdp: x",
    "Code PIN de la carte : 1234",
    "code d'accès du portail",
    "code d’accès du portail",
    "le code du wifi c'est 1234",
    "digicode 4521B",
    "IBAN FR76 3000 6000 0112 3456 7890 189",
    "cryptogramme 123",
    "CVV 123",
  ])("refuses secrets: %s", async (text) => {
    const { store } = setup();
    expect(await remember(store, "kevin", text)).toEqual({ status: "refused", reason: "secret" });
  });

  test.each([
    "On a planté un pin dans le jardin",
    "pomme de pin",
    "le code de la route",
    "Les codes postaux de la famille : 31320 et 31400",
    "Kévin code en TypeScript",
    "la porte du garage a un code couleur bleu",
  ])("accepts ordinary text: %s", async (text) => {
    const { store } = setup();
    expect((await remember(store, "kevin", text)).status).toBe("created");
  });

  test("refuses empty text, on remember and on update", async () => {
    const { store } = setup();
    expect(await remember(store, "kevin", "   ")).toEqual({ status: "refused", reason: "empty" });
    const result = await remember(store, "kevin", "Kévin adore les lasagnes");
    if (result.status !== "created") throw new Error("not created");
    expect(await store.update("kevin", result.memory.id, { text: " \n" })).toEqual({ status: "refused", reason: "empty" });
    expect(await store.update("kevin", result.memory.id, { text: "mot de passe : hunter2" })).toEqual({
      status: "refused",
      reason: "secret",
    });
    expect(store.get("kevin", result.memory.id)?.text).toBe("Kévin adore les lasagnes");
  });

  test("update never overwrites a memory moved out of reach meanwhile", async () => {
    const db = createTestDb();
    const { clock } = createTestClock();
    const embedder = new GatedEmbedder();
    const store = new MemoryStore(db, embedder, clock, { minSimilarity: 0.3 });
    const result = await remember(store, "kevin", "Le code couleur du salon est le bleu", "common");
    if (result.status !== "created") throw new Error("not created");
    const id = result.memory.id;

    const gate = Promise.withResolvers<undefined>();
    embedder.gate = gate.promise;
    const kevinEdit = store.update("kevin", id, { text: "Le salon est vert" });
    // While Kévin's new text is being embedded, Élodie takes the memory for herself.
    expect((await store.update("elodie", id, { scope: "personal" })).status).toBe("updated");
    gate.resolve(undefined);

    expect(await kevinEdit).toEqual({ status: "not_found" });
    expect(store.get("elodie", id)).toMatchObject({ scope: "elodie", text: "Le code couleur du salon est le bleu" });
    expect(store.get("kevin", id)).toBeUndefined();
  });

  test("search without recall leaves the bookkeeping alone", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    const found = await store.search("kevin", "lasagnes", { recall: false });
    expect(found.map((m) => [m.text, m.recallCount, m.lastRecalledAt])).toEqual([["Kévin adore les lasagnes", 0, null]]);
    expect(await store.search("kevin", "lasagnes", { limit: 0 })).toEqual([]);
  });

  test("update text re-embeds and moves scope (common ↔ own personal only)", async () => {
    const { store } = setup();
    const result = await remember(store, "kevin", "Élodie aime le thé vert", "common");
    if (result.status !== "created") throw new Error("not created");
    const updated = await store.update("kevin", result.memory.id, { text: "Kévin aime le thé vert", scope: "personal" });
    expect(updated.status === "updated" ? updated.memory.scope : updated.status).toBe("kevin");
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

  test("vectors from another embedding model are never compared in search", async () => {
    const db = createTestDb();
    const { clock } = createTestClock();
    const older = new MemoryStore(db, constantEmbedder("old-model"), clock);
    const current = new MemoryStore(db, constantEmbedder("new-model"), clock);
    expect((await remember(older, "kevin", "Kévin adore les lasagnes")).status).toBe("created");

    // Same model: every vector is identical, so any query matches.
    expect((await older.search("kevin", "météo demain")).map((m) => m.text)).toEqual(["Kévin adore les lasagnes"]);

    // Another model: the old vector is ignored...
    expect(await current.search("kevin", "météo demain")).toEqual([]);
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

describe("MemoryStore index upkeep", () => {
  test("rebuildIndex repairs a desynchronised full-text index", async () => {
    const { db, store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    db.$client.exec("INSERT INTO memories_fts(memories_fts) VALUES ('delete-all')");
    expect(await store.search("kevin", "lasagnes", { recall: false })).toHaveLength(1); // vector side still finds it
    const count = (): number =>
      db.$client.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'lasagnes'").pluck().get() as number;
    expect(count()).toBe(0);
    store.rebuildIndex();
    expect(count()).toBe(1);
  });
});

describe("MemoryStore warm-up", () => {
  test("warmUp asks the embedder for one vector", async () => {
    const calls: string[] = [];
    const counting: Embedder = {
      model: "counting", dimensions: 2,
      embed: (texts) => {
        calls.push(...texts);
        return Promise.resolve(texts.map(() => new Float32Array([1, 0])));
      },
    };
    await new MemoryStore(createTestDb(), counting, createTestClock().clock).warmUp();
    expect(calls).toHaveLength(1);
  });
});
