import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AttachmentStore } from "../attachments/store.ts";
import { defineTool, type ToolResult } from "../engine/tools.ts";
import type { ToolProvider } from "./catalog.ts";
import { officeTextIsolated } from "./office-isolated.ts";
import { frameUntrusted } from "./untrusted.ts";

/** What Alicia gets of a document at most (about 15,000 tokens). */
export const DOCUMENT_TEXT_MAX = 60_000;

const NOT_FOUND: ToolResult = { text: "Pièce jointe introuvable dans cette conversation.", isError: true };
const USE_READ: ToolResult = {
  text: "Ce fichier est une image ou un PDF : lis-le avec Read (chemin donné sous le message).", isError: true,
};
const UNREADABLE: ToolResult = {
  text: "Document illisible (abîmé ou protégé). Dis-le et propose d'en joindre une autre version.", isError: true,
};
const PROTECTED: ToolResult = { text: "Document protégé par mot de passe : impossible de le lire.", isError: true };
const TOO_BIG: ToolResult = {
  text: "Document refusé : une fois décompressé, il serait anormalement gros (archive piégée ?). Dis-le et propose d'en joindre une autre version.",
  isError: true,
};
const TOO_SLOW: ToolResult = {
  text: "Document refusé : il est trop lourd à lire (trop long ou trop gros). Dis-le et propose d'en joindre une version plus légère.",
  isError: true,
};
const CANCELLED: ToolResult = { text: "Lecture interrompue : la réponse s'est arrêtée.", isError: true };
const EMPTY = "Le document ne contient aucun texte lisible.";

/**
 * Text of a .txt / .csv: UTF-16 when it starts with its byte order mark (Notepad, some exports), UTF-8 when valid
 * (byte order mark dropped), otherwise Windows-1252 (CSV saved by a French Excel).
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

/** Windows-1252's 0x80–0x9F (Node's own decoder reads them as Latin-1 control characters); 0 = undefined there. */
const WINDOWS_1252_HIGH = [
  0x20_ac, 0, 0x20_1a, 0x01_92, 0x20_1e, 0x20_26, 0x20_20, 0x20_21, 0x02_c6, 0x20_30, 0x01_60, 0x20_39, 0x01_52, 0, 0x01_7d, 0,
  0, 0x20_18, 0x20_19, 0x20_1c, 0x20_1d, 0x20_22, 0x20_13, 0x20_14, 0x02_dc, 0x21_22, 0x01_61, 0x20_3a, 0x01_53, 0, 0x01_7e, 0x01_78,
];

function decodeWindows1252(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .replace(/[\u0080-\u009f]/gu, (c) => String.fromCharCode(WINDOWS_1252_HIGH[c.charCodeAt(0) - 0x80] || 0xff_fd));
}

/** At most DOCUMENT_TEXT_MAX characters (never half an emoji), and how many were left out. */
function clip(text: string): { kept: string; omitted: number } {
  if (text.length <= DOCUMENT_TEXT_MAX) return { kept: text, omitted: 0 };
  const last = text.charCodeAt(DOCUMENT_TEXT_MAX - 1);
  const cut = last >= 0xd8_00 && last <= 0xdb_ff ? DOCUMENT_TEXT_MAX - 1 : DOCUMENT_TEXT_MAX;
  return { kept: text.slice(0, cut), omitted: text.length - cut };
}

/** The text of a Word, Excel or text attachment, or why there is none. */
async function readDocument(kind: "word" | "excel" | "text", bytes: Buffer, signal: AbortSignal): Promise<string | ToolResult> {
  if (kind === "text") return decodeText(bytes);
  // In a worker thread with its own memory and a deadline, stopped with the turn; the archive is checked and rebuilt
  // before any parser opens it (zip bombs, password, disguised formats).
  const office = await officeTextIsolated(bytes, { signal });
  switch (office.status) {
    case "text":
      return office.text;
    case "too_slow":
      return TOO_SLOW;
    case "cancelled":
      return CANCELLED;
    case "protected":
      return PROTECTED;
    case "too_big":
      return TOO_BIG;
    case "unreadable":
      return UNREADABLE;
  }
}

/** document_read, bound to the turn's person and conversation: no other attachment exists for it. */
export function documentTools(store: AttachmentStore): ToolProvider {
  return ({ person, conversationId, signal }) => [
    defineTool({
      name: "document_read",
      label: "Alicia lit le document…",
      description:
        "Lit le texte d'une pièce jointe Word (.docx), Excel (.xlsx) ou texte (.txt, .csv) de cette conversation, à partir de son identifiant (donné sous le message). Les images et les PDF se lisent avec Read.",
      input: { attachment: z.uuid() },
      untrustedOutput: true,
      async run({ attachment }) {
        const found = store.pathOf(person.id, conversationId, attachment);
        if (found === undefined) return NOT_FOUND;
        const kind = found.attachment.kind;
        if (kind === "image" || kind === "pdf") return USE_READ;
        let text: string | ToolResult;
        try {
          text = await readDocument(kind, await readFile(found.path), signal);
        } catch {
          return UNREADABLE;
        }
        if (typeof text !== "string") return text;
        const source = `pièce jointe « ${found.attachment.name} »`;
        if (text.trim() === "") return { text: frameUntrusted(source, EMPTY) };
        const { kept, omitted } = clip(text);
        // Said outside the frame: the brain speaks there, not the document.
        const cut = omitted === 0 ? "" : `\n[… document tronqué : ${omitted} caractères de plus non lus]`;
        return { text: `${frameUntrusted(source, kept)}${cut}` };
      },
    }),
  ];
}
