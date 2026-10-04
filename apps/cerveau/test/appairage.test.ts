import { describe, expect, test } from "vitest";
import { appareils, codesAppairage } from "../src/base/schema.ts";
import { hacher, ServiceAppairage } from "../src/identites/appairage.ts";
import { creerBaseTest, creerHorlogeTest, ELODIE, KEVIN } from "./aides.ts";

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

  test("un code en collision n'est jamais réattribué à une autre personne", () => {
    const base = creerBaseTest();
    const temps = creerHorlogeTest();
    base
      .insert(codesAppairage)
      .values({ codeHache: hacher("111111"), personneId: "elodie", expireLe: temps.horloge() + 60_000 })
      .run();
    const tirages = ["111111", "222222"];
    const service = new ServiceAppairage(base, temps.horloge, () => tirages.shift() ?? "333333");

    expect(service.genererCode("kevin")).toBe("222222");

    const pourElodie = service.echanger("111111", "Téléphone Élodie");
    if ("erreur" in pourElodie) throw new Error(pourElodie.erreur);
    expect(pourElodie.personne).toEqual(ELODIE);
    const pourKevin = service.echanger("222222", "PC Kévin");
    if ("erreur" in pourKevin) throw new Error(pourKevin.erreur);
    expect(pourKevin.personne).toEqual(KEVIN);
  });

  test("si aucun code unique n'est trouvable, on abandonne", () => {
    const base = creerBaseTest();
    const temps = creerHorlogeTest();
    base
      .insert(codesAppairage)
      .values({ codeHache: hacher("111111"), personneId: "elodie", expireLe: temps.horloge() + 60_000 })
      .run();
    const service = new ServiceAppairage(base, temps.horloge, () => "111111");
    expect(() => service.genererCode("kevin")).toThrow(/unique/);
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

describe("ServiceAppairage — gestion des appareils", () => {
  function appairer(service: ServiceAppairage, personneId: string, nom: string): string {
    const r = service.echanger(service.genererCode(personneId), nom);
    if ("erreur" in r) throw new Error(r.erreur);
    return r.jeton;
  }

  test("liste les appareils de toutes les personnes, du plus récent au plus ancien", () => {
    const { service, temps } = creerService();
    const debut = temps.horloge();
    appairer(service, "kevin", "PC Kévin");
    temps.avancer(1000);
    const jetonTablette = appairer(service, "elodie", "Tablette");
    temps.avancer(1000);
    service.authentifier(jetonTablette);

    const liste = service.listerAppareils();
    expect(liste.map((a) => [a.personneId, a.nom])).toEqual([
      ["elodie", "Tablette"],
      ["kevin", "PC Kévin"],
    ]);
    expect(liste[0]).toMatchObject({ creeLe: debut + 1000, vuLe: debut + 2000, revoqueLe: null });
    expect(liste[1]).toMatchObject({ creeLe: debut, vuLe: null, revoqueLe: null });
    expect(liste[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("authentifierAppareil rend l'appareil et la personne ; estActif suit la révocation par id", () => {
    const { service, temps } = creerService();
    const jeton = appairer(service, "kevin", "PC");
    const auth = service.authentifierAppareil(jeton);
    expect(auth?.personne).toEqual(KEVIN);
    const id = auth?.appareilId ?? "";
    expect(service.listerAppareils()[0]?.id).toBe(id);
    expect(service.estActif(id)).toBe(true);

    temps.avancer(5000);
    expect(service.revoquerAppareil(id)).toBe(true);
    expect(service.estActif(id)).toBe(false);
    expect(service.authentifierAppareil(jeton)).toBeUndefined();
    expect(service.authentifier(jeton)).toBeUndefined();
    expect(service.listerAppareils()[0]?.revoqueLe).toBe(temps.horloge());
  });

  test("révoquer un appareil inconnu ou déjà révoqué rend false et ne change rien", () => {
    const { service, temps } = creerService();
    const jeton = appairer(service, "kevin", "PC");
    const id = service.authentifierAppareil(jeton)?.appareilId ?? "";
    expect(service.revoquerAppareil("inconnu")).toBe(false);
    expect(service.estActif("inconnu")).toBe(false);
    expect(service.revoquerAppareil(id)).toBe(true);
    const revoqueLe = service.listerAppareils()[0]?.revoqueLe;
    temps.avancer(1000);
    expect(service.revoquerAppareil(id)).toBe(false);
    expect(service.listerAppareils()[0]?.revoqueLe).toBe(revoqueLe);
  });
});
