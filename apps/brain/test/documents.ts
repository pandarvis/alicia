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
 * archive can do: lie about its sizes).
 */
export function withDeclaredSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const copy = Uint8Array.from(zip);
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
