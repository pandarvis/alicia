import { z } from "zod";
import { AttachmentSummary } from "./attachments.ts";
import { Person } from "./identity.ts";
import { MemoryRefusalReason } from "./memory.ts";

export const PairingRequest = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  deviceName: z.string().trim().min(1).max(60),
});
export type PairingRequest = z.infer<typeof PairingRequest>;

export const PairingResponse = z.object({ token: z.string(), person: Person });
export type PairingResponse = z.infer<typeof PairingResponse>;

export const HealthResponse = z.object({ ok: z.literal(true), version: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ConversationSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  updatedAt: z.iso.datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const HistoryMessage = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.iso.datetime(),
  /** The files sent with the message (none for Alicia's answers). */
  attachments: z.array(AttachmentSummary),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;

export const HttpErrorCode = z.enum([
  "invalid_request",
  "unauthenticated",
  "not_found",
  "busy",
  "duplicate",
  "refused",
  "invalid_code",
  "too_many_attempts",
  "forbidden_origin",
  // An upload refused (the same words as AttachmentRefusalReason).
  "too_large",
  "unsupported",
  "empty",
  "too_many",
  "internal",
]);
export type HttpErrorCode = z.infer<typeof HttpErrorCode>;

const RefusedError = z.object({ code: z.literal("refused"), message: z.string(), reason: MemoryRefusalReason });
const PlainError = z.object({ code: HttpErrorCode.exclude(["refused"]), message: z.string() });

/** Body of every HTTP error answer of the brain; `message` is French and may be shown as is. */
export const HttpErrorBody = z.object({ error: z.union([RefusedError, PlainError]) });
export type HttpErrorBody = z.infer<typeof HttpErrorBody>;
