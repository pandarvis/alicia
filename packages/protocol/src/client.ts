import { z } from "zod";
import { Modele } from "./identity.ts";

export const MessageAuthentifier = z.strictObject({
  type: z.literal("authentifier"),
  jeton: z.string().min(20).max(200),
});
export type MessageAuthentifier = z.infer<typeof MessageAuthentifier>;

export const MessageEnvoyer = z.strictObject({
  type: z.literal("envoyer"),
  idRequete: z.uuid(),
  conversationId: z.uuid().optional(),
  texte: z.string().max(20_000).refine((s) => s.trim().length > 0, "Message vide"),
  modele: Modele.optional(),
});
export type MessageEnvoyer = z.infer<typeof MessageEnvoyer>;

/** Tout ce que l'app peut envoyer au cerveau sur le WebSocket. */
export const MessageClient = z.discriminatedUnion("type", [MessageAuthentifier, MessageEnvoyer]);
export type MessageClient = z.infer<typeof MessageClient>;
