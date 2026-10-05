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
    const p = buildSystemPrompt(KEVIN, "");
    expect(p.startsWith(PERSONA)).toBe(true);
    expect(p).toContain("Tu parles avec Kévin.");
  });
  test("system prompt explains memory and appends the sheet", () => {
    const prompt = buildSystemPrompt(KEVIN, "Ce que tu sais déjà (mémoire) :\n- X");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("Tu parles avec Kévin.");
    expect(prompt.endsWith("Ce que tu sais déjà (mémoire) :\n- X")).toBe(true);
    expect(buildSystemPrompt(KEVIN, "")).not.toContain("Ce que tu sais déjà");
  });
  test("stable: no date in the system prompt", () => {
    expect(buildSystemPrompt(KEVIN, "")).toBe(buildSystemPrompt(KEVIN, ""));
    expect(buildSystemPrompt(KEVIN, "")).not.toMatch(/2026/);
  });
  test("the tools guide follows the turn's tools", () => {
    const withWeather = buildSystemPrompt(KEVIN, "", ["memory_search", "weather", "document_read"]);
    expect(withWeather).toContain("Pour la météo à la maison, utilise weather.");
    expect(withWeather).toContain("document_read");
    expect(withWeather).toContain("WebSearch");
    expect(withWeather).toContain("n'invente jamais son résultat");
    expect(withWeather).toContain("Si elle refuse, n'insiste pas");
    expect(buildSystemPrompt(KEVIN, "", ["memory_search"])).not.toContain("weather");
    expect(buildSystemPrompt(KEVIN, "")).not.toContain("weather");
  });
  test("timestamps the message in Paris time", () => {
    const instant = new Date(Date.UTC(2026, 9, 4, 13, 30));
    expect(timestamp("Coucou", instant, "Europe/Paris")).toBe("[dimanche 4 octobre 2026 à 15:30]\nCoucou");
  });
});
