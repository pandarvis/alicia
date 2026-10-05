import { crc32 } from "node:zlib";
import { strToU8, type Zippable, zipSync } from "fflate";
import { utils, write } from "xlsx";

const escapeXml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The parts of a minimal Word document holding these paragraphs (more parts may be added). */
export function docxParts(paragraphs: readonly string[]): Zippable {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`).join("");
  return {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  };
}

/** A minimal Word document holding these paragraphs. */
export function docx(paragraphs: readonly string[]): Uint8Array {
  return zipSync(docxParts(paragraphs));
}

/** A workbook: sheet name → rows. */
export function xlsx(sheets: Readonly<Record<string, readonly (readonly (string | number)[])[]>>): Uint8Array {
  const book = utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    utils.book_append_sheet(book, utils.aoa_to_sheet(rows.map((row) => [...row])), name);
  }
  const out: unknown = write(book, { type: "buffer", bookType: "xlsx" });
  if (!(out instanceof Uint8Array)) throw new Error("SheetJS did not return a buffer");
  return out;
}

const CENTRAL_ENTRY = 0x02_01_4b_50;

/**
 * A copy of `zip` whose central directory declares another uncompressed size for the entry `name` (what a crafted
 * archive can do: lie about its sizes). With `local`, its local header tells the same lie (a consistent archive).
 */
export function withDeclaredSize(zip: Uint8Array, name: string, size: number, local = true): Uint8Array {
  const copy = local ? withLocalSize(zip, name, size) : Uint8Array.from(zip);
  const view = new DataView(copy.buffer);
  for (let at = 0; at + 46 <= copy.length; at++) {
    if (view.getUint32(at, true) !== CENTRAL_ENTRY) continue;
    const nameLength = view.getUint16(at + 28, true);
    if (new TextDecoder().decode(copy.subarray(at + 46, at + 46 + nameLength)) === name) {
      view.setUint32(at + 24, size, true);
      return copy;
    }
  }
  throw new Error(`no entry ${name}`);
}

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The start of a compound file, holding these stream names (UTF-16LE, as in its directory). */
export function compoundFile(streams: readonly string[]): Uint8Array {
  const names = streams.flatMap((name) => [...Buffer.from(name, "utf16le")]);
  return Uint8Array.from([...CFB_SIGNATURE, ...Array<number>(504).fill(0), ...names, ...Array<number>(64).fill(0)]);
}

const LOCAL_ENTRY = 0x04_03_4b_50;
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

/** Every part of `parts` as raw bytes (the Zippable values docxParts gives are byte arrays). */
export function partsBytes(parts: Zippable): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(parts)) {
    if (!(value instanceof Uint8Array)) throw new Error(`${name}: not bytes`);
    out[name] = value;
  }
  return out;
}

export interface RawZipOptions {
  /** The archive comment (after the end record). */
  comment?: Uint8Array;
  /** Extra field of every local header. */
  localExtra?: Uint8Array;
  /** Flag bit 3 (sizes and CRC after the data, zeros in the local header), as streaming writers do. */
  dataDescriptor?: boolean;
  /** Bytes between the last entry and the central directory. */
  gap?: Uint8Array;
}

/** A ZIP written by hand (stored entries), so that tests can bend any field a crafted archive could bend. */
export function rawZip(entries: Readonly<Record<string, Uint8Array>>, options: RawZipOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const flags = options.dataDescriptor === true ? 0x08 : 0;
  const localExtra = options.localExtra ?? new Uint8Array(0);
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_ENTRY, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, flags === 0 ? crc : 0, true);
    local.setUint32(18, flags === 0 ? data.length : 0, true);
    local.setUint32(22, flags === 0 ? data.length : 0, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, localExtra.length, true);
    const descriptor = new DataView(new ArrayBuffer(flags === 0 ? 0 : 16));
    if (flags !== 0) {
      descriptor.setUint32(0, 0x08_07_4b_50, true);
      descriptor.setUint32(4, crc, true);
      descriptor.setUint32(8, data.length, true);
      descriptor.setUint32(12, data.length, true);
    }
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, CENTRAL_ENTRY, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, flags, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), nameBytes);
    for (const part of [new Uint8Array(local.buffer), nameBytes, localExtra, data, new Uint8Array(descriptor.buffer)]) {
      chunks.push(part);
      offset += part.length;
    }
  }
  if (options.gap !== undefined) {
    chunks.push(options.gap);
    offset += options.gap.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const comment = options.comment ?? new Uint8Array(0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.setUint16(8, Object.keys(entries).length, true);
  end.setUint16(10, Object.keys(entries).length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, comment.length, true);
  return Uint8Array.from(Buffer.concat([...chunks, ...central, new Uint8Array(end.buffer), comment]));
}

/** A copy of `zip` whose local header of `name` declares another uncompressed size than its central entry. */
export function withLocalSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const copy = Uint8Array.from(zip);
  const view = new DataView(copy.buffer);
  for (let at = 0; at + 30 <= copy.length; at++) {
    if (view.getUint32(at, true) !== LOCAL_ENTRY) continue;
    const nameLength = view.getUint16(at + 26, true);
    if (new TextDecoder().decode(copy.subarray(at + 30, at + 30 + nameLength)) === name) {
      view.setUint32(at + 22, size, true);
      return copy;
    }
  }
  throw new Error(`no entry ${name}`);
}
