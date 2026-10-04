import { z } from "zod";
import { Personne } from "./identite.ts";

export const RequeteAppairage = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  nomAppareil: z.string().trim().min(1).max(60),
});
export type RequeteAppairage = z.infer<typeof RequeteAppairage>;

export const ReponseAppairage = z.object({ jeton: z.string(), personne: Personne });
export type ReponseAppairage = z.infer<typeof ReponseAppairage>;

export const ReponseSante = z.object({ ok: z.literal(true), version: z.string() });
export type ReponseSante = z.infer<typeof ReponseSante>;

export const ResumeConversation = z.object({
  id: z.uuid(),
  titre: z.string(),
  majLe: z.iso.datetime(),
});
export type ResumeConversation = z.infer<typeof ResumeConversation>;

export const MessageHistorique = z.object({
  id: z.uuid(),
  role: z.enum(["utilisateur", "alicia"]),
  texte: z.string(),
  creeLe: z.iso.datetime(),
});
export type MessageHistorique = z.infer<typeof MessageHistorique>;
