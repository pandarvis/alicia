import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, type AttachmentRefusalReason, formatSize, MAX_ATTACHMENTS_PER_MESSAGE,
} from "@alicia/protocol";

/** For the file picker: the extensions Alicia takes. */
export const ACCEPTED_FILES = ATTACHMENT_TYPES.map((t) => t.extension).join(",");

const SUPPORTED = "images, PDF, Word (.docx), Excel (.xlsx) et texte (.txt, .csv)";

export const TOO_MANY = `${MAX_ATTACHMENTS_PER_MESSAGE} pièces jointes au maximum par message.`;

/** Why a file was not attached, in French (checked before uploading, or answered by the brain). */
export function refusalText(name: string, size: number, reason: AttachmentRefusalReason | "failed"): string {
  switch (reason) {
    case "too_large":
      return `« ${name} » est trop gros (${formatSize(size)}) : ${formatSize(ATTACHMENT_MAX_BYTES)} au maximum.`;
    case "unsupported":
      return `« ${name} » n'est pas pris en charge : ${SUPPORTED}.`;
    case "empty":
      return `« ${name} » est vide.`;
    case "too_many":
      return `« ${name} » n'a pas été joint : trop de fichiers attendent déjà d'être envoyés. Envoie ou retire-les, puis réessaie.`;
    case "failed":
      return `« ${name} » n'a pas pu être envoyé à Alicia : retire-le et réessaie.`;
  }
}
