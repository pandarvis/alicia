import { describe, expect, test } from "vitest";
import { chooseModel } from "../src/agent/model.ts";
import { buildSystemPrompt, PERSONA, timestamp } from "../src/agent/system-prompt.ts";
import { KEVIN } from "./helpers.ts";

describe("chooseModel", () => {
  test("Sonnet by default", () => {
    expect(chooseModel(undefined, "Bonjour")).toBe("sonnet");
  });
  test("Opus when the interface asks for it", () => {
    expect(chooseModel("opus", "Bonjour")).toBe("opus");
  });
  test("Opus when the user says « réfléchis bien », with or without accents", () => {
    expect(chooseModel(undefined, "Réfléchis bien : quel menu ?")).toBe("opus");
    expect(chooseModel("sonnet", "reflechis bien stp")).toBe("opus");
  });
});

describe("system prompt", () => {
  test("contains the personality and the first name of the person talking", () => {
    const p = buildSystemPrompt(KEVIN);
    expect(p.startsWith(PERSONA)).toBe(true);
    expect(p).toContain("Tu parles avec Kévin.");
  });
  test("stable: no date in the system prompt", () => {
    expect(buildSystemPrompt(KEVIN)).toBe(buildSystemPrompt(KEVIN));
    expect(buildSystemPrompt(KEVIN)).not.toMatch(/2026/);
  });
  test("timestamps the message in Paris time", () => {
    const instant = new Date(Date.UTC(2026, 9, 4, 13, 30));
    expect(timestamp("Coucou", instant, "Europe/Paris")).toBe("[dimanche 4 octobre 2026 à 15:30]\nCoucou");
  });
});
