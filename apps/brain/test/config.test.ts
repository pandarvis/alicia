import { describe, expect, test } from "vitest";
import { parseConfig, readAuthentication } from "../src/config.ts";

const MINIMAL_YAML = `
personnes:
  - { id: kevin, name: Kévin }
  - { id: elodie, name: Élodie }
moteur:
  mode: abonnement
`;

describe("parseConfig", () => {
  test("applies the defaults", () => {
    const c = parseConfig(MINIMAL_YAML);
    expect(c.port).toBe(8780);
    expect(c.hote).toBe("0.0.0.0");
    expect(c.fuseau).toBe("Europe/Paris");
    expect(c.modeles).toEqual({ sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(c.personnes.map((p) => p.id)).toEqual(["kevin", "elodie"]);
  });
  test("rejects a config without any person", () => {
    expect(() => parseConfig("personnes: []\nmoteur: { mode: abonnement }")).toThrow();
  });
  test("rejects an unknown engine mode", () => {
    expect(() => parseConfig("personnes: [{ id: kevin, name: K }]\nmoteur: { mode: gratuit }")).toThrow();
  });
});

describe("readAuthentication", () => {
  test("subscription: reads CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(readAuthentication("abonnement", { CLAUDE_CODE_OAUTH_TOKEN: "token" })).toEqual({
      mode: "abonnement", token: "token",
    });
  });
  test("API key: reads ANTHROPIC_API_KEY", () => {
    expect(readAuthentication("cle_api", { ANTHROPIC_API_KEY: "key" })).toEqual({
      mode: "cle_api", key: "key",
    });
  });
  test("missing secret: explicit message", () => {
    expect(() => readAuthentication("abonnement", {})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
