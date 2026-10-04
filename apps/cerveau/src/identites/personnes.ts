import type { Personne } from "@alicia/protocole";
import { eq } from "drizzle-orm";
import type { Base } from "../base/ouvrir.ts";
import { personnes } from "../base/schema.ts";

/** Crée ou renomme les personnes déclarées dans la config. Ne supprime jamais. */
export function synchroniserPersonnes(base: Base, liste: readonly Personne[]): void {
  for (const p of liste) {
    base
      .insert(personnes)
      .values(p)
      .onConflictDoUpdate({ target: personnes.id, set: { nom: p.nom } })
      .run();
  }
}

export function trouverPersonne(base: Base, id: string): Personne | undefined {
  return base.select().from(personnes).where(eq(personnes.id, id)).get();
}
