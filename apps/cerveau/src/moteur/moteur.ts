import type { Modele } from "@alicia/protocole";

export interface RequeteMoteur {
  prompt: string;
  /** Session SDK à reprendre ; undefined = nouvelle session. */
  sessionId: string | undefined;
  modele: Modele;
  consigneSysteme: string;
}

/** Ce que le moteur raconte pendant un tour, indépendamment du SDK. */
export type EvenementMoteur =
  | { type: "session"; sessionId: string }
  | { type: "texte"; texte: string }
  | { type: "appel_outil"; idAppel: string; outil: string }
  | { type: "resultat_outil"; idAppel: string; succes: boolean }
  | { type: "fin"; tokensEntree: number; tokensSortie: number }
  | { type: "erreur"; code: "quota" | "moteur"; message: string };

export interface Moteur {
  executer(requete: RequeteMoteur, signal: AbortSignal): AsyncIterable<EvenementMoteur>;
}
