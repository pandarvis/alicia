import type { MemorySummary, MemoryTestHit } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import {
  formatDate, hitReasons, provenance, usage,
} from "../src/renderer/src/lib/memory-labels.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

function memory(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    scope: "personal",
    kind: "fact",
    text: "Le chat s'appelle Moka",
    pinned: false,
    source: "manual",
    conversationId: null,
    conversationTitle: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    recallCount: 0,
    lastRecalledAt: null,
    forgottenAt: null,
    ...overrides,
  };
}

function hit(textMatch: boolean, similarity: number): MemoryTestHit {
  return { memory: memory(), rank: 1, textMatch, similarity };
}

describe("memory labels", () => {
  test("dates in French, long style", () => {
    expect(formatDate("2026-10-04T12:00:00.000Z")).toBe("4 octobre 2026");
  });

  test("provenance: a conversation still there is a link", () => {
    expect(provenance(memory({ source: "conversation", conversationId: CONV, conversationTitle: "Lasagnes" }))).toEqual({
      text: "Retenu par Alicia pendant",
      conversation: { id: CONV, title: "Lasagnes" },
    });
  });

  test("provenance: deleted conversation, someone else's, by hand, imported", () => {
    expect(provenance(memory({ source: "conversation" }))).toEqual({
      text: "Retenu pendant une conversation supprimée",
      conversation: null,
    });
    expect(provenance(memory({ source: "conversation", conversationId: CONV })).text).toBe(
      "Retenu par Alicia pendant la conversation de quelqu'un d'autre",
    );
    expect(provenance(memory({ source: "manual" })).text).toBe("Ajouté à la main");
    expect(provenance(memory({ source: "import" })).text).toBe("Importé de l'ancienne Alice");
  });

  test("usage", () => {
    expect(usage(memory())).toBe("Jamais utilisé");
    expect(usage(memory({ recallCount: 3, lastRecalledAt: "2026-10-02T12:00:00.000Z" }))).toBe(
      "Utilisé 3 fois, la dernière fois le 2 octobre 2026",
    );
    expect(usage(memory({ recallCount: 1, lastRecalledAt: "2026-10-02T12:00:00.000Z" }))).toBe(
      "Utilisé 1 fois, la dernière fois le 2 octobre 2026",
    );
    // Imported counts may come without a date.
    expect(usage(memory({ recallCount: 4 }))).toBe("Utilisé 4 fois");
  });

  test("bench reasons: shared words, close in meaning (from the search floor), or both", () => {
    expect(hitReasons(hit(true, 0.5))).toEqual(["mots en commun"]);
    expect(hitReasons(hit(false, 0.82))).toEqual(["sens proche"]);
    expect(hitReasons(hit(true, 0.9))).toEqual(["mots en commun", "sens proche"]);
    expect(hitReasons(hit(false, 0.81))).toEqual([]);
  });
});
