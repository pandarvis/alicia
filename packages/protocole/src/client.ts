import { z } from "zod";
import { Modele } from "./identite.ts";

export const MessageAuthentifier = z.object({
  type: z.literal("authentifier"),
  jeton: z.string().min(20).max(200),
});

export const MessageEnvoyer = z.object({
  type: z.literal("envoyer"),
  idRequete: z.uuid(),
  conversationId: z.uuid().optional(),
  texte: z.string().trim().min(1).max(20_000),
  modele: Modele.optional(),
});
export type MessageEnvoyer = z.infer<typeof MessageEnvoyer>;

/** Tout ce que l'app peut envoyer au cerveau sur le WebSocket. */
export const MessageClient = z.discriminatedUnion("type", [MessageAuthentifier, MessageEnvoyer]);
export type MessageClient = z.infer<typeof MessageClient>;
