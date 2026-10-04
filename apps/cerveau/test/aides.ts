import type { Personne } from "@alicia/protocol";
import { ouvrirBase } from "../src/base/ouvrir.ts";
import { synchroniserPersonnes } from "../src/identites/personnes.ts";

export const KEVIN: Personne = { id: "kevin", nom: "Kévin" };
export const ELODIE: Personne = { id: "elodie", nom: "Élodie" };

/** Horloge de test : avance à la main. */
export function creerHorlogeTest(depart = Date.UTC(2026, 9, 4, 13, 30)) {
  let maintenant = depart;
  return {
    horloge: () => maintenant,
    avancer: (ms: number) => {
      maintenant += ms;
    },
  };
}

/** Base en mémoire avec Kévin et Élodie. */
export function creerBaseTest() {
  const base = ouvrirBase(":memory:");
  synchroniserPersonnes(base, [KEVIN, ELODIE]);
  return base;
}
