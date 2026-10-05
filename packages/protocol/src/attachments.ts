import { z } from "zod";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/**
 * The brain's refusal (an `invalid_request` error) of a message whose files it no longer has (expired, already
 * sent): the only refusal after which the app uploads the message's files again.
 */
export const ATTACHMENT_GONE_MESSAGE = "Pièce jointe introuvable ou expirée : joins-la à nouveau.";

export const ATTACHMENT_KINDS = ["image", "pdf", "word", "excel", "text"] as const;
export const AttachmentKind = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export interface AttachmentType {
  extension: string;
  kind: AttachmentKind;
  mediaType: string;
}

/** The only files Alicia accepts, by extension (the brain also checks the content). */
export const ATTACHMENT_TYPES: readonly AttachmentType[] = [
  { extension: ".png", kind: "image", mediaType: "image/png" },
  { extension: ".jpg", kind: "image", mediaType: "image/jpeg" },
  { extension: ".jpeg", kind: "image", mediaType: "image/jpeg" },
  { extension: ".gif", kind: "image", mediaType: "image/gif" },
  { extension: ".webp", kind: "image", mediaType: "image/webp" },
  { extension: ".pdf", kind: "pdf", mediaType: "application/pdf" },
  { extension: ".docx", kind: "word", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { extension: ".xlsx", kind: "excel", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { extension: ".txt", kind: "text", mediaType: "text/plain" },
  { extension: ".csv", kind: "text", mediaType: "text/csv" },
];

/** The accepted type of a file name, by its extension (any case); undefined when Alicia does not take it. */
export function attachmentTypeOf(name: string): AttachmentType | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot).toLowerCase();
  return ATTACHMENT_TYPES.find((t) => t.extension === extension);
}

/** "too_many": the person already has too many files waiting to be sent (decided by the brain). */
export type AttachmentRefusalReason = "unsupported" | "too_large" | "empty" | "too_many";
export type AttachmentCheck =
  | { ok: true; type: AttachmentType }
  | { ok: false; reason: Exclude<AttachmentRefusalReason, "too_many"> };

/** Checked by the app before uploading and by the brain on receipt. */
export function checkAttachment(name: string, size: number): AttachmentCheck {
  const type = attachmentTypeOf(name);
  if (type === undefined) return { ok: false, reason: "unsupported" };
  if (size === 0) return { ok: false, reason: "empty" };
  if (size > ATTACHMENT_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, type };
}

/** « 512 o », « 13 Ko », « 1,2 Mo ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

/** Header carrying the file name (UTF-8, percent-encoded) of an upload. */
export const ATTACHMENT_NAME_HEADER = "x-attachment-name";

/** What the app knows of an attachment: never its path, only what is shown. */
export const AttachmentSummary = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  kind: AttachmentKind,
  size: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummary>;
