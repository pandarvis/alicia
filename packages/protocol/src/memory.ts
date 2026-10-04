import { z } from "zod";

export const MEMORY_KINDS = ["rule", "preference", "habit", "fact", "event"] as const;
export const MemoryKind = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Seen from the person asking: their own memories are "personal", the household's are "common". */
export const MemoryScope = z.enum(["common", "personal"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

const count = z.number().int().nonnegative();
const memoryText = z.string().trim().min(1).max(1000);

/** Where a memory comes from: Alicia in a conversation, typed by hand, or imported from the old Alice. */
export const MemorySource = z.enum(["conversation", "manual", "import"]);
export type MemorySource = z.infer<typeof MemorySource>;

/** Why the brain refused to write a memory: it looked like a secret, or was empty once cleaned. */
export const MemoryRefusalReason = z.enum(["secret", "empty"]);
export type MemoryRefusalReason = z.infer<typeof MemoryRefusalReason>;

export const MemorySummary = z.object({
  id: z.uuid(),
  scope: MemoryScope,
  kind: MemoryKind,
  text: z.string(),
  pinned: z.boolean(),
  source: MemorySource,
  conversationId: z.uuid().nullable(),
  /** Title of the source conversation when it still exists and belongs to the caller. */
  conversationTitle: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  recallCount: count,
  lastRecalledAt: z.iso.datetime().nullable(),
  forgottenAt: z.iso.datetime().nullable(),
});
export type MemorySummary = z.infer<typeof MemorySummary>;

/** One result of the test bench: what Alicia would find for a question, and why. */
export const MemoryTestHit = z.object({
  memory: MemorySummary,
  /** 1-based, in the order Alicia receives them. */
  rank: z.number().int().positive(),
  /** Found through shared words (full-text index). */
  textMatch: z.boolean(),
  /** Cosine similarity with the question (0 when the memory's vector is from another model). */
  similarity: z.number().min(-1).max(1),
});
export type MemoryTestHit = z.infer<typeof MemoryTestHit>;

export const MemoryCreate = z.strictObject({
  text: memoryText,
  kind: MemoryKind,
  scope: MemoryScope,
  pinned: z.boolean().optional(),
});
export type MemoryCreate = z.infer<typeof MemoryCreate>;

export const MemoryPatch = z.strictObject({
  text: memoryText.optional(),
  kind: MemoryKind.optional(),
  scope: MemoryScope.optional(),
  pinned: z.boolean().optional(),
}).refine((patch) => Object.keys(patch).length > 0, "Rien à modifier");
export type MemoryPatch = z.infer<typeof MemoryPatch>;
