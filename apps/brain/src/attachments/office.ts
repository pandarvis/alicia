import { crc32, inflateRawSync } from "node:zlib";
import { zipSync } from "fflate";
import { CFB } from "./sniff.ts";

/**
 * What a .docx / .xlsx really is. Word or Excel: `archive` is the document rebuilt from its checked, inflated parts
 * (the only bytes a parser may ever see).
 */
export type OfficeArchive =
  | { status: "word" | "excel"; archive: Uint8Array }
  /** A compound file holding an encrypted package: Office's password protection. */
  | { status: "protected" }
  /** Would inflate far beyond any family document: a zip bomb, or an archive lying about its sizes. */
  | { status: "too_big" }
  /** Broken, ambiguous, an old binary format in disguise, or not a Word / Excel document at all. */
  | { status: "unreadable" };

/** Generous for a family document (a 25 MB upload of real Word / Excel stays far below). */
export const OFFICE_LIMITS = {
  /** Sum of the entries once inflated. */
  totalBytes: 50 * 1024 * 1024,
  entries: 5_000,
  /** An entry above `ratioFloor` inflating more than `ratio` times its size is no document part. */
  ratio: 500,
  ratioFloor: 1024 * 1024,
} as const;

const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
const END_RECORD_SIZE = 22;
const CENTRAL_ENTRY = 0x02_01_4b_50;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_ENTRY = 0x04_03_4b_50;
const LOCAL_HEADER_SIZE = 30;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x1;
const DATA_DESCRIPTOR = 0x8;
const ZIP64_MARK = 0xff_ff_ff_ff;
const ZIP64_EXTRA = 0x0001;
/** The stream name of an encrypted package, as the compound file's directory writes it (UTF-16LE). */
const ENCRYPTED_PACKAGE = Buffer.from("EncryptedPackage", "utf16le");
const END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

interface Entry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

class Refused extends Error {
  readonly status: "too_big" | "unreadable";

  constructor(status: "too_big" | "unreadable") {
    super(status);
    this.status = status;
  }
}

const unreadable = (): never => {
  throw new Refused("unreadable");
};
const tooBig = (): never => {
  throw new Refused("too_big");
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, i) => bytes[i] === value);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

/** True when the extra field holds a ZIP64 block (never in a family document; some readers would trust it). */
function hasZip64(view: DataView, start: number, length: number): boolean {
  let at = start;
  while (at + 4 <= start + length) {
    if (view.getUint16(at, true) === ZIP64_EXTRA) return true;
    at += 4 + view.getUint16(at + 2, true);
  }
  return false;
}

/**
 * The end record: exactly the last 22 bytes (no comment, where a second record could hide), one disk, as many
 * entries on it as in total, and a central directory ending right before it.
 */
function endRecord(view: DataView): { count: number; offset: number; end: number } {
  const end = view.byteLength - END_RECORD_SIZE;
  if (end < 0 || view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) return unreadable();
  if (view.getUint16(end + 20, true) !== 0) return unreadable();
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) return unreadable();
  const count = view.getUint16(end + 10, true);
  if (view.getUint16(end + 8, true) !== count) return unreadable();
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  // ZIP64 (over 65,535 entries or 4 GB): never a family document.
  if (count === 0xff_ff || offset === ZIP64_MARK || size === ZIP64_MARK) return tooBig();
  if (offset + size !== end) return unreadable();
  return { count, offset, end };
}

/** The central directory, checked against the limits before anything is inflated. */
function centralDirectory(bytes: Uint8Array, view: DataView): { entries: Entry[]; directory: number; end: number } {
  const { count, offset, end } = endRecord(view);
  if (count > OFFICE_LIMITS.entries) return tooBig();
  const entries: Entry[] = [];
  const names = new Set<string>();
  let total = 0;
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_SIZE > end || view.getUint32(at, true) !== CENTRAL_ENTRY) return unreadable();
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const next = at + CENTRAL_HEADER_SIZE + nameLength + extraLength + view.getUint16(at + 32, true);
    if (next > end) return unreadable();
    const nameBytes = bytes.slice(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength);
    const entry: Entry = {
      name: new TextDecoder("utf-8", { fatal: true }).decode(nameBytes),
      nameBytes,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    if (entry.size === ZIP64_MARK || entry.compressedSize === ZIP64_MARK) return tooBig();
    if (hasZip64(view, at + CENTRAL_HEADER_SIZE + nameLength, extraLength)) return unreadable();
    // Encrypted the ZIP way (never how Office protects a file), or a method no parser should guess at.
    if ((entry.flags & ENCRYPTED) !== 0 || (entry.method !== STORED && entry.method !== DEFLATED)) return unreadable();
    if (names.has(entry.name)) return unreadable();
    names.add(entry.name);
    total += entry.size;
    if (total > OFFICE_LIMITS.totalBytes) return tooBig();
    if (entry.size > OFFICE_LIMITS.ratioFloor && entry.size > entry.compressedSize * OFFICE_LIMITS.ratio) return tooBig();
    entries.push(entry);
    at = next;
  }
  if (at !== end) return unreadable();
  return { entries, directory: offset, end };
}

/** Where the entry's data starts, once its local header agrees with the central directory in every respect. */
function localData(bytes: Uint8Array, view: DataView, entry: Entry): number {
  const at = entry.localOffset;
  if (at + LOCAL_HEADER_SIZE > bytes.length || view.getUint32(at, true) !== LOCAL_ENTRY) return unreadable();
  const flags = view.getUint16(at + 6, true);
  if (flags !== entry.flags || view.getUint16(at + 8, true) !== entry.method) return unreadable();
  const crc = view.getUint32(at + 14, true);
  const compressedSize = view.getUint32(at + 18, true);
  const size = view.getUint32(at + 22, true);
  const agrees = crc === entry.crc && compressedSize === entry.compressedSize && size === entry.size;
  // With a data descriptor, a streaming writer leaves zeros here.
  const deferred = (flags & DATA_DESCRIPTOR) !== 0 && crc === 0 && compressedSize === 0 && size === 0;
  if (!agrees && !deferred) return unreadable();
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  if (!sameBytes(bytes.subarray(at + LOCAL_HEADER_SIZE, at + LOCAL_HEADER_SIZE + nameLength), entry.nameBytes)) {
    return unreadable();
  }
  if (hasZip64(view, at + LOCAL_HEADER_SIZE + nameLength, extraLength)) return unreadable();
  return at + LOCAL_HEADER_SIZE + nameLength + extraLength;
}

/** The entry inflated, never beyond what it declares, checked against its CRC. */
function inflateEntry(bytes: Uint8Array, start: number, entry: Entry, directory: number): Uint8Array {
  if (start + entry.compressedSize > directory) return unreadable();
  const data = bytes.subarray(start, start + entry.compressedSize);
  let content: Uint8Array;
  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) return unreadable();
    content = data;
  } else {
    try {
      // One byte more than declared allowed, so that going beyond is told apart from a broken stream.
      content = inflateRawSync(data, { maxOutputLength: entry.size + 1 });
    } catch (error) {
      return error instanceof RangeError ? tooBig() : unreadable();
    }
    if (content.length > entry.size) return tooBig();
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) return unreadable();
  return content;
}

/**
 * Checks a .docx / .xlsx before any parser opens it, then rebuilds it. Every reader of ZIP files resolves its own
 * ambiguities (which end record, local or central sizes…): only an archive with a single reading is accepted —
 * one end record at the very end, local headers agreeing with the central directory, no ZIP64, no end record
 * signature outside the entries' data. Limits (entries, inflated total, ratios) are checked from the directory,
 * then every entry is inflated within what it declares. The parsers get a fresh archive built from those parts
 * alone. Word or Excel is decided by the parts (`word/document.xml`, `xl/workbook.xml`), not the extension. A
 * compound file is an encrypted package (password) or an old binary format in disguise.
 */
export function prepareOffice(bytes: Uint8Array): OfficeArchive {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (startsWith(bytes, CFB)) return { status: buffer.includes(ENCRYPTED_PACKAGE) ? "protected" : "unreadable" };
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { entries, directory, end } = centralDirectory(bytes, view);
    const word = entries.some((e) => e.name === "word/document.xml");
    const excel = entries.some((e) => e.name === "xl/workbook.xml");
    if (word === excel) return { status: "unreadable" };
    // The entries' data, as [start, end) ranges: an end record signature anywhere else is a second reading.
    const covered: [number, number][] = [];
    const parts: Record<string, Uint8Array> = {};
    for (const entry of entries) {
      const start = localData(bytes, view, entry);
      parts[entry.name] = inflateEntry(bytes, start, entry, directory);
      covered.push([start, start + entry.compressedSize]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    let from = 0;
    for (const [start, stop] of [...covered, [end, end] as [number, number]]) {
      if (start < from) return { status: "unreadable" };
      if (buffer.subarray(from, start).includes(END_SIGNATURE)) return { status: "unreadable" };
      from = stop;
    }
    // Stored, not compressed again: the parsers inflate nothing, the size is already bounded.
    return { status: word ? "word" : "excel", archive: zipSync(parts, { level: 0 }) };
  } catch (error) {
    if (error instanceof Refused) return { status: error.status };
    return { status: "unreadable" };
  }
}
