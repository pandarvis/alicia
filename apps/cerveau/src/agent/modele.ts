import type { Modele } from "@alicia/protocole";

const REFLECHIS_BIEN = /r[ée]fl[ée]chis bien/i;

/** Sonnet par défaut ; Opus si l'interface le demande ou si on dit « réfléchis bien ». */
export function choisirModele(demande: Modele | undefined, texte: string): Modele {
  return demande === "opus" || REFLECHIS_BIEN.test(texte) ? "opus" : "sonnet";
}
