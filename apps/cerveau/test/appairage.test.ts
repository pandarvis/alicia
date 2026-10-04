import { describe, expect, test } from "vitest";
import { appareils } from "../src/base/schema.ts";
import { ServiceAppairage } from "../src/identites/appairage.ts";
import { creerBaseTest, creerHorlogeTest, KEVIN } from "./aides.ts";

function creerService() {
  const base = creerBaseTest();
  const temps = creerHorlogeTest();
  return { base, temps, service: new ServiceAppairage(base, temps.horloge) };
}

describe("ServiceAppairage", () => {
  test("le code fait 6 chiffres et s'échange contre un jeton lié à la personne", () => {
    const { service } = creerService();
    const code = service.genererCode("kevin");
    expect(code).toMatch(/^\d{6}$/);
    const r = service.echanger(code, "PC Kévin");
    if ("erreur" in r) throw new Error(r.erreur);
    expect(r.personne).toEqual(KEVIN);
    expect(r.jeton.length).toBeGreaterThanOrEqual(43);
    expect(service.authentifier(r.jeton)).toEqual(KEVIN);
  });

  test("le jeton n'est jamais stocké en clair", () => {
    const { base, service } = creerService();
    const r = service.echanger(service.genererCode("kevin"), "PC");
    if ("erreur" in r) throw new Error(r.erreur);
    const ligne = base.select().from(appareils).get();
    expect(ligne?.jetonHache).not.toBe(r.jeton);
    expect(ligne?.jetonHache).toMatch(/^[0-9a-f]{64}$/);
  });

  test("un code ne sert qu'une fois", () => {
    const { service } = creerService();
    const code = service.genererCode("kevin");
    service.echanger(code, "PC");
    expect(service.echanger(code, "PC")).toEqual({ erreur: "code_invalide" });
  });

  test("un code expire après 10 minutes", () => {
    const { service, temps } = creerService();
    const code = service.genererCode("kevin");
    temps.avancer(10 * 60_000 + 1);
    expect(service.echanger(code, "PC")).toEqual({ erreur: "code_invalide" });
  });

  test("au-delà de 5 échecs par minute, tout est refusé, même un bon code", () => {
    const { service, temps } = creerService();
    const bon = service.genererCode("kevin");
    for (let i = 0; i < 5; i++) service.echanger("000000", "PC");
    expect(service.echanger(bon, "PC")).toEqual({ erreur: "trop_de_tentatives" });
    temps.avancer(60_001);
    expect("jeton" in service.echanger(bon, "PC")).toBe(true);
  });

  test("personne inconnue : refus de générer un code", () => {
    const { service } = creerService();
    expect(() => service.genererCode("inconnu")).toThrow(/inconnue/);
  });

  test("jeton inconnu ou révoqué : pas d'authentification", () => {
    const { service } = creerService();
    expect(service.authentifier("x".repeat(43))).toBeUndefined();
    const r = service.echanger(service.genererCode("kevin"), "PC");
    if ("erreur" in r) throw new Error(r.erreur);
    service.revoquer(r.jeton);
    expect(service.authentifier(r.jeton)).toBeUndefined();
  });
});
