import { describe, expect, test } from "vitest";
import { buildSheet } from "../src/memory/sheet.ts";
import type { Memory } from "../src/memory/store.ts";

const memory = (text: string, overrides: Partial<Memory> = {}): Memory => ({
  id: text, scope: "common", kind: "fact", text, pinned: true, source: "manual", conversationId: null,
  recallCount: 0, lastRecalledAt: null, forgottenAt: null, createdAt: 0, updatedAt: 0, ...overrides,
});

describe("buildSheet", () => {
  test("empty memory → empty sheet", () => {
    expect(buildSheet({ rules: [], pinnedCommon: [], pinnedPersonal: [] }, "Kévin")).toBe("");
  });

  test("sections in order: rules, personal, household", () => {
    const sheet = buildSheet(
      {
        rules: [memory("Pas plus de 20 °C", { kind: "rule" })],
        pinnedCommon: [memory("Le chat s'appelle Moka")],
        pinnedPersonal: [memory("Allergique aux noix", { scope: "kevin" })],
      },
      "Kévin",
    );
    expect(sheet).toBe(
      "Ce que tu sais déjà (mémoire) :\n" +
        "Règles de la maison :\n- Pas plus de 20 °C\n" +
        "À propos de Kévin :\n- Allergique aux noix\n" +
        "À propos de la famille :\n- Le chat s'appelle Moka",
    );
  });

  test("respects the budget, rules first", () => {
    const long = "x".repeat(60);
    const sheet = buildSheet(
      { rules: [memory("Règle importante", { kind: "rule" })], pinnedCommon: [], pinnedPersonal: [memory(long), memory(`${long}2`)] },
      "Kévin",
      150,
    );
    expect(sheet).toContain("Règle importante");
    expect(sheet.length).toBeLessThanOrEqual(150);
    expect(sheet).not.toContain(`${long}2`);
  });
});
