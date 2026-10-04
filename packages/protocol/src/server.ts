import { z } from "zod";
import { Modele, Personne } from "./identity.ts";

export const CodeErreur = z.enum(["quota", "moteur", "requete_invalide", "non_authentifie", "occupe", "interne"]);
export type CodeErreur = z.infer<typeof CodeErreur>;

const entier = z.number().int().nonnegative();

/** Tout ce que le cerveau peut envoyer à l'app sur le WebSocket. */
export const EvenementServeur = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pret"), personne: Personne }),
  z.object({ type: z.literal("conversation"), idRequete: z.uuid(), conversationId: z.uuid() }),
  z.object({ type: z.literal("morceau_texte"), conversationId: z.uuid(), texte: z.string() }),
  z.object({
    type: z.literal("appel_outil"), conversationId: z.uuid(), idAppel: z.string(), outil: z.string(),
  }),
  z.object({
    type: z.literal("resultat_outil"), conversationId: z.uuid(), idAppel: z.string(), succes: z.boolean(),
  }),
  z.object({
    type: z.literal("fin"),
    conversationId: z.uuid(),
    modele: Modele,
    tokensEntree: entier,
    tokensSortie: entier,
    dureeMs: entier,
  }),
  z.object({
    type: z.literal("erreur"),
    idRequete: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    code: CodeErreur,
    message: z.string(),
  }),
]);
export type EvenementServeur = z.infer<typeof EvenementServeur>;
