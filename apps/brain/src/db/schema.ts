import { ATTACHMENT_KINDS, GOOGLE_ACCOUNT_STATUSES, MEMORY_KINDS } from "@alicia/protocol";
import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull().references(() => people.id),
    title: text("title").notNull(),
    sessionId: text("session_id"),
    /** When outside content (page, search, mail, attachment) first entered the conversation; never cleared. */
    untrustedAt: integer("untrusted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("conversations_person_updated_idx").on(table.personId, table.updatedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

export const turnLog = sqliteTable(
  "turn_log",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    durationMs: integer("duration_ms").notNull(),
    tools: text("tools").notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // Deleting a conversation deletes its log (and the foreign key check looks it up).
    index("turn_log_conversation_idx").on(table.conversationId),
    // Rotation beyond 90 days.
    index("turn_log_created_idx").on(table.createdAt),
  ],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    /** "common" (household) or a person id. */
    scope: text("scope").notNull(),
    kind: text("kind", { enum: MEMORY_KINDS }).notNull(),
    text: text("text").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["conversation", "manual", "import"] }).notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** Idempotent imports (e.g. "alice:chroma:<id>"). */
    importKey: text("import_key").unique(),
    /** Float32 vector, little-endian. */
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: integer("last_recalled_at"),
    /** Soft delete: purged for good after 30 days. */
    forgottenAt: integer("forgotten_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("memories_scope_idx").on(table.scope, table.forgottenAt),
    // Deleting a conversation sets its memories' conversation_id to NULL.
    index("memories_conversation_idx").on(table.conversationId),
  ],
);

/**
 * Files sent to Alicia. Pending (uploaded, not yet sent in a message) while conversation_id is null; the file
 * itself lives in <dataDir>/attachments (see AttachmentStore), under a generated name.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull().references(() => people.id),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Display name only: the file on disk is <id><extension>. */
    name: text("name").notNull(),
    kind: text("kind", { enum: ATTACHMENT_KINDS }).notNull(),
    extension: text("extension").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("attachments_conversation_idx").on(table.conversationId),
    index("attachments_person_idx").on(table.personId, table.conversationId),
  ],
);

/**
 * Connected Google accounts (calendar, Gmail): the household's ("common") or one person's. Only ever reached
 * through GoogleAccountStore, which keeps a person to "common" and their own.
 */
export const googleAccounts = sqliteTable(
  "google_accounts",
  {
    id: text("id").primaryKey(),
    /** "common" (household) or a person id. */
    owner: text("owner").notNull(),
    /** Lowercased; a Google account is either the household's or one person's. */
    email: text("email").notNull().unique(),
    /** Granted scopes, sorted, space-separated. */
    scopes: text("scopes").notNull(),
    /** AES-256-GCM, bound to id + owner (google/token-cipher.ts). Never stored in clear. */
    refreshToken: blob("refresh_token", { mode: "buffer" }).notNull(),
    status: text("status", { enum: GOOGLE_ACCOUNT_STATUSES }).notNull(),
    createdAt: integer("created_at").notNull(),
    /** Last successful connection (marking "reconnect" leaves it). */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("google_accounts_owner_idx").on(table.owner)],
);
