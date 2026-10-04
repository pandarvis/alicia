import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const people = sqliteTable("personnes", {
  id: text("id").primaryKey(),
  name: text("nom").notNull(),
});

export const devices = sqliteTable("appareils", {
  id: text("id").primaryKey(),
  personId: text("personne_id").notNull().references(() => people.id),
  name: text("nom").notNull(),
  tokenHash: text("jeton_hache").notNull().unique(),
  createdAt: integer("cree_le").notNull(),
  lastSeenAt: integer("vu_le"),
  revokedAt: integer("revoque_le"),
});

export const pairingCodes = sqliteTable("codes_appairage", {
  codeHash: text("code_hache").primaryKey(),
  personId: text("personne_id").notNull().references(() => people.id),
  expiresAt: integer("expire_le").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  personId: text("personne_id").notNull().references(() => people.id),
  title: text("titre").notNull(),
  sessionId: text("session_id"),
  createdAt: integer("cree_le").notNull(),
  updatedAt: integer("maj_le").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("texte").notNull(),
  createdAt: integer("cree_le").notNull(),
});

export const turnLog = sqliteTable("journal", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  model: text("modele").notNull(),
  inputTokens: integer("tokens_entree").notNull(),
  outputTokens: integer("tokens_sortie").notNull(),
  durationMs: integer("duree_ms").notNull(),
  tools: text("outils").notNull(),
  error: text("erreur"),
  createdAt: integer("cree_le").notNull(),
});
