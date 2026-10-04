import type { Person } from "@alicia/protocol";
import { ouvrirBase } from "../src/db/open.ts";
import { synchroniserPersonnes } from "../src/identity/people.ts";

export const KEVIN: Person = { id: "kevin", nom: "Kévin" };
export const ELODIE: Person = { id: "elodie", nom: "Élodie" };

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
