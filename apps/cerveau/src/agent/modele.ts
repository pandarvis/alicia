import type { Model } from "@alicia/protocol";

const REFLECHIS_BIEN = /r[ée]fl[ée]chis bien/i;

/** Sonnet par défaut ; Opus si l'interface le demande ou si on dit « réfléchis bien ». */
export function choisirModele(demande: Model | undefined, texte: string): Model {
  return demande === "opus" || REFLECHIS_BIEN.test(texte) ? "opus" : "sonnet";
}
