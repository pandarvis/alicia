import { z } from "zod";

/** One MIME part of a Gmail message (recursive). */
export interface MessagePart {
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?: { data?: string | undefined; attachmentId?: string | undefined } | undefined;
  parts?: MessagePart[] | undefined;
}

export const MessagePart: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
    parts: z.array(MessagePart).optional(),
  }),
);

/** Real mails nest a few levels; anything deeper is not read (a crafted mail cannot exhaust the stack). */
const MAX_DEPTH = 32;
/** At most this many attachment names are given. */
const MAX_ATTACHMENTS = 64;
/** A body is cut to this many characters before any cleaning (the cleaning's cost stays bounded). */
const MAX_BODY = 200_000;

export function headerOf(part: MessagePart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((header) => header.name.toLowerCase() === wanted)?.value;
}

function charsetOf(part: MessagePart): string | undefined {
  return /charset="?([\w.:-]+)"?/i.exec(headerOf(part, "Content-Type") ?? "")?.[1];
}

/** Gmail body data (base64url) in its declared charset; unknown charsets fall back to UTF-8. */
export function decodeBody(data: string, charset: string | undefined): string {
  const bytes = Buffer.from(data, "base64url");
  let text: string;
  try {
    text = new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return text.slice(0, MAX_BODY);
}

const isAttachment = (part: MessagePart): boolean => (part.filename ?? "") !== "";

function find(part: MessagePart, mimeType: string, depth = 0): MessagePart | undefined {
  if (depth > MAX_DEPTH || isAttachment(part)) return undefined;
  if (part.mimeType === mimeType && part.body?.data !== undefined) return part;
  for (const child of part.parts ?? []) {
    const found = find(child, mimeType, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The readable body: text/plain if any, else text/html turned into text. Attachments are never read. */
export function extractText(payload: MessagePart | undefined): string {
  if (payload === undefined) return "";
  const plain = find(payload, "text/plain");
  if (plain?.body?.data !== undefined) return decodeBody(plain.body.data, charsetOf(plain)).trim();
  const html = find(payload, "text/html");
  if (html?.body?.data !== undefined) return htmlToText(decodeBody(html.body.data, charsetOf(html)));
  return "";
}

function collectNames(part: MessagePart, depth: number, names: string[]): void {
  if (depth > MAX_DEPTH || names.length >= MAX_ATTACHMENTS) return;
  if (isAttachment(part)) names.push(part.filename ?? "");
  for (const child of part.parts ?? []) collectNames(child, depth + 1, names);
}

/** Names of the attached files (never their content), the first ones only. */
export function attachmentNames(payload: MessagePart | undefined): string[] {
  if (payload === undefined) return [];
  const names: string[] = [];
  collectNames(payload, 0, names);
  return names.slice(0, MAX_ATTACHMENTS);
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const value = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Rough HTML → text for reading a mail: no scripts, styles or tags; paragraphs become lines. */
export function htmlToText(html: string): string {
  const text = html
    .slice(0, MAX_BODY)
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    // An unclosed script or style: everything after it is code, not text.
    .replace(/<(script|style)\b[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\xa0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
