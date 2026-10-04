import { z } from "zod";

export const IdPersonne = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
export type IdPersonne = z.infer<typeof IdPersonne>;

export const Personne = z.object({
  id: IdPersonne,
  nom: z.string().min(1).max(60),
});
export type Personne = z.infer<typeof Personne>;

/** Modèle demandé par l'interface : le cerveau traduit en identifiant Anthropic. */
export const Modele = z.enum(["sonnet", "opus"]);
export type Modele = z.infer<typeof Modele>;
