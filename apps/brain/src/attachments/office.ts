import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { CFB } from "./sniff.ts";

/** What a .docx / .xlsx really is, checked before any parser opens it. */
export type OfficeCheck =
  | { status: "word" | "excel" }
  /** A compound file holding an encrypted package: Office's password protection. */
  | { status: "protected" }
  /** Would inflate far beyond any family document: a zip bomb, or an archive lying about its sizes. */
  | { status: "too_big" }
  /** Broken, an old binary format in disguise, or not a Word / Excel document at all. */
  | { status: "unreadable" };

/** Generous for a family document (a 25 MB upload of real Word / Excel stays far below). */
export const OFFICE_LIMITS = {
  /** Sum of the entries once inflated. */
  totalBytes: 100 * 1024 * 1024,
  entries: 5_000,
  /** An entry above `ratioFloor` inflating more than `ratio` times its size is no document part. */
  ratio: 500,
  ratioFloor: 1024 * 1024,
} as const;

const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
const CENTRAL_ENTRY = 0x02_01_4b_50;
const LOCAL_ENTRY = 0x04_03_4b_50;
const STORED = 0;
const DEFLATED = 8;
const ZIP64_MARK = 0xff_ff_ff_ff;
/** The stream name of an encrypted package, as the compound file's directory writes it (UTF-16LE). */
const ENCRYPTED_PACKAGE = Buffer.from("EncryptedPackage", "utf16le");

const inflate = promisify(inflateRaw);

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, i) => bytes[i] === value);

/** The central directory's entries; a string when the archive is refused. */
function centralDirectory(bytes: Uint8Array): Entry[] | "too_big" | "unreadable" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 22 bytes, plus a comment of up to 65,535 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xff_ff); at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) return "unreadable";
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  // ZIP64 (over 65,535 entries or 4 GB): never a family document.
  if (count === 0xff_ff || offset === ZIP64_MARK) return "too_big";
  if (count > OFFICE_LIMITS.entries) return "too_big";
  const entries: Entry[] = [];
  let total = 0;
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_ENTRY) return "unreadable";
    const flags = view.getUint16(at + 8, true);
    const entry: Entry = {
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
      name: "",
    };
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > bytes.length) return "unreadable";
    entry.name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // An entry encrypted the ZIP way is not how Office protects a file.
    if ((flags & 1) !== 0) return "unreadable";
    if (entry.size === ZIP64_MARK || entry.compressedSize === ZIP64_MARK) return "too_big";
    total += entry.size;
    if (total > OFFICE_LIMITS.totalBytes) return "too_big";
    if (entry.size > OFFICE_LIMITS.ratioFloor && entry.size > entry.compressedSize * OFFICE_LIMITS.ratio) return "too_big";
    entries.push(entry);
    at = next;
  }
  return entries;
}

/** Inflates every entry, never beyond what it declares: an archive lying about its sizes is caught here. */
async function inflatesAsDeclared(bytes: Uint8Array, entries: readonly Entry[]): Promise<"ok" | "too_big" | "unreadable"> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const entry of entries) {
    const at = entry.localOffset;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_ENTRY) return "unreadable";
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (data.length !== entry.compressedSize) return "unreadable";
    if (entry.method === STORED) {
      if (entry.compressedSize !== entry.size) return "unreadable";
      continue;
    }
    if (entry.method !== DEFLATED) return "unreadable";
    let inflated: Buffer;
    try {
      // Allowed one byte more than declared, so that going beyond is told apart from a broken stream.
      inflated = await inflate(data, { maxOutputLength: entry.size + 1 });
    } catch (error) {
      return error instanceof RangeError ? "too_big" : "unreadable";
    }
    if (inflated.length > entry.size) return "too_big";
    if (inflated.length !== entry.size) return "unreadable";
  }
  return "ok";
}

/**
 * Checks a .docx / .xlsx before mammoth or SheetJS opens it: its central directory (entry count, inflated sizes,
 * compression ratios), then every entry actually inflated within what it declares. The type comes from the archive
 * (`word/document.xml` or `xl/workbook.xml`), not from the extension. A compound file is an encrypted package
 * (password) or an old binary format in disguise.
 */
export async function checkOffice(bytes: Uint8Array): Promise<OfficeCheck> {
  if (startsWith(bytes, CFB)) {
    const encrypted = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(ENCRYPTED_PACKAGE);
    return { status: encrypted ? "protected" : "unreadable" };
  }
  const entries = centralDirectory(bytes);
  if (typeof entries === "string") return { status: entries };
  const names = new Set(entries.map((e) => e.name));
  const word = names.has("word/document.xml");
  const excel = names.has("xl/workbook.xml");
  if (word === excel) return { status: "unreadable" };
  const inflation = await inflatesAsDeclared(bytes, entries);
  if (inflation !== "ok") return { status: inflation };
  return { status: word ? "word" : "excel" };
}
