import { describe, expect, test } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.ts";
import type { EngineRequest } from "../src/engine/engine.ts";
import { callTool } from "../src/engine/fake-engine.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { createTestClock, createTestDb, createTestMemory, ELODIE, KEVIN } from "./helpers.ts";

function setup() {
  const db = createTestDb();
  const { clock } = createTestClock();
  const store = createTestMemory(db, clock);
  const repository = new ConversationRepository(db, clock);
  // Memories point to the conversation they were learnt in: it must exist.
  const requestFor = (person: typeof KEVIN): EngineRequest => ({
    prompt: "", sessionId: undefined, model: "sonnet", systemPrompt: "",
    tools: memoryTools(store)({ person, conversationId: repository.create(person.id, "Test").id }),
  });
  return { store, kevin: requestFor(KEVIN), elodie: requestFor(ELODIE) };
}

const SECRET_REFUSAL = { text: "Refusé : je ne retiens ni mots de passe ni codes.", isError: true };

describe("memory tools", () => {
  test("remember then search through the tools", async () => {
    const { kevin } = setup();
    const saved = await callTool(kevin, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
    expect(saved.text).toMatch(/^Retenu/);
    const found = await callTool(kevin, "memory_search", { query: "lasagnes" });
    expect(found.text).toContain("Kévin adore les lasagnes");
    expect(found.text).toContain("personnel");
  });

  test("duplicate and refused secrets are explained", async () => {
    const { kevin } = setup();
    await callTool(kevin, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
    expect((await callTool(kevin, "memory_remember", { text: "kévin adore les lasagnes", kind: "preference", scope: "personal" })).text)
      .toMatch(/^Déjà en mémoire/);
    const refused = await callTool(kevin, "memory_remember", { text: "Mot de passe wifi : hunter2", kind: "fact", scope: "common" });
    expect(refused).toEqual(SECRET_REFUSAL);
  });

  test("an empty text is refused", async () => {
    const { kevin } = setup();
    const refused = await callTool(kevin, "memory_remember", { text: "   ", kind: "fact", scope: "common" });
    expect(refused).toEqual({ text: "Refusé : le souvenir est vide.", isError: true });
  });

  test("cloisonnement through the tools: Élodie can't touch Kévin's memory even with its id", async () => {
    const { store, kevin, elodie } = setup();
    await callTool(kevin, "memory_remember", { text: "Surprise pour l'anniversaire d'Élodie", kind: "event", scope: "personal" });
    const id = store.list("kevin", {})[0]?.id ?? "";
    expect((await callTool(elodie, "memory_search", { query: "anniversaire surprise" })).text).toBe("Aucun souvenir trouvé.");
    expect(await callTool(elodie, "memory_update", { id, text: "rien" })).toEqual({ text: "Souvenir introuvable.", isError: true });
    expect(await callTool(elodie, "memory_forget", { id })).toEqual({ text: "Souvenir introuvable.", isError: true });
    expect(store.get("kevin", id)?.text).toBe("Surprise pour l'anniversaire d'Élodie");
  });

  test("update and forget", async () => {
    const { store, kevin } = setup();
    await callTool(kevin, "memory_remember", { text: "Kévin boit du café", kind: "habit", scope: "personal" });
    const id = store.list("kevin", {})[0]?.id ?? "";
    expect((await callTool(kevin, "memory_update", { id, text: "Kévin boit du thé", pinned: true })).text).toMatch(/^Mis à jour/);
    expect(store.get("kevin", id)).toMatchObject({ text: "Kévin boit du thé", pinned: true });
    expect(await callTool(kevin, "memory_update", { id, text: "Le code de la porte : 4521" })).toEqual(SECRET_REFUSAL);
    expect(store.get("kevin", id)?.text).toBe("Kévin boit du thé");
    expect((await callTool(kevin, "memory_forget", { id })).text).toBe("Oublié (récupérable 30 jours).");
    expect(store.get("kevin", id)).toBeUndefined();
  });
});
