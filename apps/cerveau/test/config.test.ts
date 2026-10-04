import { describe, expect, test } from "vitest";
import { lireAuthentification, lireConfig } from "../src/config.ts";

const YAML_MINIMAL = `
personnes:
  - { id: kevin, nom: Kévin }
  - { id: elodie, nom: Élodie }
moteur:
  mode: abonnement
`;

describe("lireConfig", () => {
  test("applique les valeurs par défaut", () => {
    const c = lireConfig(YAML_MINIMAL);
    expect(c.port).toBe(8780);
    expect(c.hote).toBe("0.0.0.0");
    expect(c.fuseau).toBe("Europe/Paris");
    expect(c.modeles).toEqual({ sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(c.personnes.map((p) => p.id)).toEqual(["kevin", "elodie"]);
  });
  test("refuse une config sans personne", () => {
    expect(() => lireConfig("personnes: []\nmoteur: { mode: abonnement }")).toThrow();
  });
  test("refuse un mode de moteur inconnu", () => {
    expect(() => lireConfig("personnes: [{ id: kevin, nom: K }]\nmoteur: { mode: gratuit }")).toThrow();
  });
});

describe("lireAuthentification", () => {
  test("abonnement : lit CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(lireAuthentification("abonnement", { CLAUDE_CODE_OAUTH_TOKEN: "jeton" })).toEqual({
      mode: "abonnement", jeton: "jeton",
    });
  });
  test("clé API : lit ANTHROPIC_API_KEY", () => {
    expect(lireAuthentification("cle_api", { ANTHROPIC_API_KEY: "cle" })).toEqual({
      mode: "cle_api", cle: "cle",
    });
  });
  test("secret manquant : message explicite", () => {
    expect(() => lireAuthentification("abonnement", {})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
