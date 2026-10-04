import { describe, expect, test } from "vitest";
import { construireConsigne, horodater, PERSONA } from "../src/agent/consigne.ts";
import { choisirModele } from "../src/agent/modele.ts";
import { KEVIN } from "./aides.ts";

describe("choisirModele", () => {
  test("Sonnet par défaut", () => {
    expect(choisirModele(undefined, "Bonjour")).toBe("sonnet");
  });
  test("Opus sur demande de l'interface", () => {
    expect(choisirModele("opus", "Bonjour")).toBe("opus");
  });
  test("Opus quand on dit « réfléchis bien », avec ou sans accents", () => {
    expect(choisirModele(undefined, "Réfléchis bien : quel menu ?")).toBe("opus");
    expect(choisirModele("sonnet", "reflechis bien stp")).toBe("opus");
  });
});

describe("consigne", () => {
  test("contient la personnalité et le prénom de l'interlocuteur", () => {
    const c = construireConsigne(KEVIN);
    expect(c.startsWith(PERSONA)).toBe(true);
    expect(c).toContain("Tu parles avec Kévin.");
  });
  test("stable : aucune date dans la consigne", () => {
    expect(construireConsigne(KEVIN)).toBe(construireConsigne(KEVIN));
    expect(construireConsigne(KEVIN)).not.toMatch(/2026/);
  });
  test("horodate le message à l'heure de Paris", () => {
    const instant = new Date(Date.UTC(2026, 9, 4, 13, 30));
    expect(horodater("Coucou", instant, "Europe/Paris")).toBe("[dimanche 4 octobre 2026 à 15:30]\nCoucou");
  });
});
