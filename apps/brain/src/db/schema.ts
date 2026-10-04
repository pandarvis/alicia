import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
});

export const pairingCodes = sqliteTable("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id),
  expiresAt: integer("expires_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id),
  title: text("title").notNull(),
  sessionId: text("session_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const turnLog = sqliteTable("turn_log", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  durationMs: integer("duration_ms").notNull(),
  tools: text("tools").notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});
