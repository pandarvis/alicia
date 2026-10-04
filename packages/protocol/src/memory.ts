import { z } from "zod";

export const MEMORY_KINDS = ["rule", "preference", "habit", "fact", "event"] as const;
export const MemoryKind = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Seen from the person asking: their own memories are "personal", the household's are "common". */
export const MemoryScope = z.enum(["common", "personal"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

const count = z.number().int().nonnegative();
const memoryText = z.string().trim().min(1).max(1000);

export const MemorySummary = z.object({
  id: z.uuid(),
  scope: MemoryScope,
  kind: MemoryKind,
  text: z.string(),
  pinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  recallCount: count,
});
export type MemorySummary = z.infer<typeof MemorySummary>;

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
