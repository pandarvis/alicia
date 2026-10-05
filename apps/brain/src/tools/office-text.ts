// Runs inside the document worker (office-worker.ts) too: relative `.ts` imports and plain JavaScript packages only.
import mammoth from "mammoth";
import { read, utils } from "xlsx";
import { prepareOffice } from "../attachments/office.ts";

/** Rows read per sheet: a family spreadsheet is far smaller; a huge one is cut. */
const SHEET_ROWS_MAX = 5_000;

/** The text of a Word or Excel document, or why there is none. */
export type OfficeText =
  | { status: "text"; text: string }
  | { status: "protected" | "too_big" | "unreadable" };

function workbookText(archive: Buffer): string {
  // No formulas, styles, HTML or macros: only the displayed values.
  const workbook = read(archive, {
    type: "buffer", dense: true, sheetRows: SHEET_ROWS_MAX, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false,
  });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = sheet === undefined ? "" : utils.sheet_to_csv(sheet, { blankrows: false, strip: true });
    return `## Feuille « ${name} »\n${csv.trim()}`;
  }).join("\n\n");
}

/**
 * A .docx / .xlsx as text: checked and rebuilt first (prepareOffice), then only the rebuilt archive goes to mammoth
 * or SheetJS. Never throws.
 */
export async function officeText(bytes: Uint8Array): Promise<OfficeText> {
  const prepared = prepareOffice(bytes);
  if (prepared.status !== "word" && prepared.status !== "excel") return { status: prepared.status };
  const archive = Buffer.from(prepared.archive.buffer, prepared.archive.byteOffset, prepared.archive.byteLength);
  try {
    const text = prepared.status === "word"
      ? (await mammoth.extractRawText({ buffer: archive })).value
      : workbookText(archive);
    return { status: "text", text };
  } catch {
    return { status: "unreadable" };
  }
}
