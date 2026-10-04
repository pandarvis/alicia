import { randomUUID } from "node:crypto";
import type { Model } from "@alicia/protocol";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Base } from "../base/ouvrir.ts";
import { conversations, journal, messages } from "../base/schema.ts";
import type { Horloge } from "../horloge.ts";

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Role = Message["role"];

export interface AppelOutilJournal {
  idAppel: string;
  outil: string;
  succes: boolean | null;
}

export interface EntreeJournal {
  conversationId: string;
  modele: Model;
  tokensEntree: number;
  tokensSortie: number;
  dureeMs: number;
  outils: readonly AppelOutilJournal[];
  erreur: string | null;
}

/**
 * Dépôt des conversations, messages et journal.
 *
 * Cloisonnement : seul `obtenir` vérifie la propriété. `definirSession`, `ajouterMessage`,
 * `messages` et `derniersMessages` ne prennent qu'un `conversationId` et ne contrôlent PAS
 * à qui il appartient : l'appelant doit d'abord passer par `obtenir(id, personneId)`.
 */
export class DepotConversations {
  readonly #base: Base;
  readonly #horloge: Horloge;

  constructor(base: Base, horloge: Horloge) {
    this.#base = base;
    this.#horloge = horloge;
  }

  creer(personneId: string, titre: string): Conversation {
    const maintenant = this.#horloge();
    const c: Conversation = {
      id: randomUUID(), personneId, titre, sessionId: null, creeLe: maintenant, majLe: maintenant,
    };
    this.#base.insert(conversations).values(c).run();
    return c;
  }

  /** Ne renvoie la conversation que si elle appartient à cette personne. */
  obtenir(id: string, personneId: string): Conversation | undefined {
    return this.#base
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.personneId, personneId)))
      .get();
  }

  lister(personneId: string): Conversation[] {
    return this.#base
      .select()
      .from(conversations)
      .where(eq(conversations.personneId, personneId))
      .orderBy(desc(conversations.majLe), sql`rowid desc`)
      .limit(100)
      .all();
  }

  definirSession(id: string, sessionId: string | null): void {
    this.#base.update(conversations).set({ sessionId }).where(eq(conversations.id, id)).run();
  }

  ajouterMessage(conversationId: string, role: Role, texte: string): void {
    const maintenant = this.#horloge();
    this.#base.transaction((tx) => {
      tx.insert(messages)
        .values({ id: randomUUID(), conversationId, role, texte, creeLe: maintenant })
        .run();
      tx.update(conversations)
        .set({ majLe: maintenant })
        .where(eq(conversations.id, conversationId))
        .run();
    });
  }

  messages(conversationId: string): Message[] {
    return this.#base
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.creeLe), sql`rowid`)
      .all();
  }

  derniersMessages(conversationId: string, nombre: number): Message[] {
    return this.#base
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.creeLe), sql`rowid desc`)
      .limit(nombre)
      .all()
      .reverse();
  }

  journaliser(entree: EntreeJournal): void {
    this.#base
      .insert(journal)
      .values({
        id: randomUUID(),
        conversationId: entree.conversationId,
        modele: entree.modele,
        tokensEntree: entree.tokensEntree,
        tokensSortie: entree.tokensSortie,
        dureeMs: entree.dureeMs,
        outils: JSON.stringify(entree.outils),
        erreur: entree.erreur,
        creeLe: this.#horloge(),
      })
      .run();
  }
}
