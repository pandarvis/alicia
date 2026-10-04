import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const personnes = sqliteTable("personnes", {
  id: text("id").primaryKey(),
  nom: text("nom").notNull(),
});

export const appareils = sqliteTable("appareils", {
  id: text("id").primaryKey(),
  personneId: text("personne_id").notNull().references(() => personnes.id),
  nom: text("nom").notNull(),
  jetonHache: text("jeton_hache").notNull().unique(),
  creeLe: integer("cree_le").notNull(),
  vuLe: integer("vu_le"),
  revoqueLe: integer("revoque_le"),
});

export const codesAppairage = sqliteTable("codes_appairage", {
  codeHache: text("code_hache").primaryKey(),
  personneId: text("personne_id").notNull().references(() => personnes.id),
  expireLe: integer("expire_le").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  personneId: text("personne_id").notNull().references(() => personnes.id),
  titre: text("titre").notNull(),
  sessionId: text("session_id"),
  creeLe: integer("cree_le").notNull(),
  majLe: integer("maj_le").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["utilisateur", "alicia"] }).notNull(),
  texte: text("texte").notNull(),
  creeLe: integer("cree_le").notNull(),
});

export const journal = sqliteTable("journal", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  modele: text("modele").notNull(),
  tokensEntree: integer("tokens_entree").notNull(),
  tokensSortie: integer("tokens_sortie").notNull(),
  dureeMs: integer("duree_ms").notNull(),
  outils: text("outils").notNull(),
  erreur: text("erreur"),
  creeLe: integer("cree_le").notNull(),
});
