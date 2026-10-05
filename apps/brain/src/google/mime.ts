import { z } from "zod";

/** Printable ASCII only: such a header value goes as is. */
const PLAIN = /^[ -~]*$/;
/**
 * Characters no header value may hold: control characters (CR, LF, NUL, tab, DEL, C1 — next line included) and the
 * Unicode line and paragraph separators. A line break would let a value add headers (Bcc…).
 */
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/**
 * A message id as it appears in Message-ID / In-Reply-To / References: <left@right>, printable ASCII, no bracket or
 * "@" inside either side, at most 250 characters each (bounded: a crafted header cannot make the scan quadratic).
 */
const MESSAGE_ID = /<[!-;=?A-~]{1,250}@[!-;=?A-~]{1,250}>/g;
/** References kept after the thread's first id. */
const REFERENCES_KEPT = 20;
/** UTF-8 bytes per encoded word: base64 of 45 bytes is 60 characters, under the 75 of RFC 2047. */
const WORD_BYTES = 45;
const BODY_LINE = 76;

/** A bare address (no display name, list or group): what Alicia writes in From / To / Cc. */
const Address = z.email();

export interface DraftMessage {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body: string;
  /** Message-ID of the mail answered, taken from that (outside) mail: only well-formed ids are kept. */
  inReplyTo?: string | undefined;
  /** References of the mail answered, plus its id: same rule. */
  references?: string | undefined;
}

/** A header value as RFC 2047 encoded words when it is not plain ASCII (or too long for one line). */
export function encodeHeader(value: string): string {
  if (PLAIN.test(value) && value.length <= 900) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** A control character or line separator in a value would let it add headers: refused. */
function header(name: string, value: string): string {
  if (FORBIDDEN.test(value)) throw new Error(`Forbidden character in the ${name} header`);
  return `${name}: ${encodeHeader(value)}`;
}

/** Bare ASCII addresses, one per folded line (never encoded words: RFC 2047 forbids them in an address). */
function addresses(name: string, list: readonly string[]): string {
  for (const address of list) {
    if (!PLAIN.test(address) || !Address.safeParse(address).success) throw new Error(`Invalid address in the ${name} header`);
  }
  return `${name}: ${list.join(",\r\n ")}`;
}

/** The well-formed message ids of an outside header, in order (none when there are none). */
function messageIds(value: string | undefined): string[] {
  return [...(value ?? "").matchAll(MESSAGE_ID)].map((match) => match[0]);
}

/**
 * Message ids as one header: printable ASCII already (never encoded words, which would break threading), one id per
 * folded line. A long thread keeps its first id and its last ones, as RFC 5322 suggests trimming References.
 */
function idHeader(name: string, ids: readonly string[]): string {
  const kept = ids.length > REFERENCES_KEPT + 1 ? [ids[0] ?? "", ...ids.slice(-REFERENCES_KEPT)] : ids;
  return `${name}: ${kept.join("\r\n ")}`;
}

/** A plain-text mail (UTF-8, base64 body), base64url-encoded as Gmail's `raw` field expects. */
export function buildRawMessage(message: DraftMessage): string {
  const body = Buffer.from(message.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += BODY_LINE) lines.push(body.slice(i, i + BODY_LINE));
  const inReplyTo = messageIds(message.inReplyTo).slice(0, 1);
  const references = messageIds(message.references);
  const text = [
    addresses("From", [message.from]),
    ...(message.to.length > 0 ? [addresses("To", message.to)] : []),
    ...(message.cc.length > 0 ? [addresses("Cc", message.cc)] : []),
    header("Subject", message.subject),
    ...(inReplyTo.length > 0 ? [idHeader("In-Reply-To", inReplyTo)] : []),
    ...(references.length > 0 ? [idHeader("References", references)] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
    "",
    ...lines,
  ].join("\r\n");
  return Buffer.from(text, "utf8").toString("base64url");
}
