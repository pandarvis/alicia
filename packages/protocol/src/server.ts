import { z } from "zod";
import { Model, Person } from "./identity.ts";

export const ErrorCode = z.enum(["quota", "moteur", "requete_invalide", "non_authentifie", "occupe", "interne"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const count = z.number().int().nonnegative();

/** Everything the brain can send to the app over the WebSocket. */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pret"), personne: Person }),
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
    modele: Model,
    tokensEntree: count,
    tokensSortie: count,
    dureeMs: count,
  }),
  z.object({
    type: z.literal("erreur"),
    idRequete: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    code: ErrorCode,
    message: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
