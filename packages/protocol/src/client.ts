import { z } from "zod";
import { Model } from "./identity.ts";

export const AuthenticateMessage = z.strictObject({
  type: z.literal("authentifier"),
  jeton: z.string().min(20).max(200),
});
export type AuthenticateMessage = z.infer<typeof AuthenticateMessage>;

export const SendMessage = z.strictObject({
  type: z.literal("envoyer"),
  idRequete: z.uuid(),
  conversationId: z.uuid().optional(),
  texte: z.string().max(20_000).refine((s) => s.trim().length > 0, "Empty message"),
  modele: Model.optional(),
});
export type SendMessage = z.infer<typeof SendMessage>;

/** Everything the app can send to the brain over the WebSocket. */
export const ClientMessage = z.discriminatedUnion("type", [AuthenticateMessage, SendMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;
