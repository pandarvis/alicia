import type { Person } from "@alicia/protocol";
import { eq } from "drizzle-orm";
import type { Base } from "../db/open.ts";
import { personnes } from "../db/schema.ts";

/** Crée ou renomme les personnes déclarées dans la config. Ne supprime jamais. */
export function synchroniserPersonnes(base: Base, liste: readonly Person[]): void {
  for (const p of liste) {
    base
      .insert(personnes)
      .values(p)
      .onConflictDoUpdate({ target: personnes.id, set: { nom: p.nom } })
      .run();
  }
}

export function trouverPersonne(base: Base, id: string): Person | undefined {
  return base.select().from(personnes).where(eq(personnes.id, id)).get();
}
