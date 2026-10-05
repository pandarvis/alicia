import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { OFFICE_LIMITS, prepareOffice } from "../src/attachments/office.ts";
import { compoundFile, docx, docxParts, partsBytes, rawZip, withDeclaredSize, withLocalSize, xlsx } from "./documents.ts";

const statusOf = (bytes: Uint8Array): string => prepareOffice(bytes).status;
const END_RECORD = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...Array<number>(18).fill(0)]);

describe("prepareOffice", () => {
  test("Word and Excel, decided by the archive; the parsers only ever get a rebuilt archive", () => {
    const word = prepareOffice(docx(["Bonjour"]));
    if (word.status !== "word") throw new Error(word.status);
    // Rebuilt: the same parts, the same contents, nothing else.
    const parts = unzipSync(word.archive);
    expect(Object.keys(parts).sort()).toEqual(Object.keys(docxParts(["Bonjour"])).sort());
    expect(new TextDecoder().decode(parts["word/document.xml"])).toContain("Bonjour");
    expect(statusOf(xlsx({ A: [["x"]] }))).toBe("excel");
    expect(statusOf(zipSync({ "notes.txt": strToU8("x") }))).toBe("unreadable");
    expect(statusOf(zipSync({ ...docxParts(["x"]), "xl/workbook.xml": strToU8("<x/>") }))).toBe("unreadable");
  });

  test("a hand-written archive with data descriptors (streaming writers) is read", () => {
    expect(statusOf(rawZip(partsBytes(docxParts(["x"])), { dataDescriptor: true }))).toBe("word");
    expect(statusOf(rawZip(partsBytes(docxParts(["x"]))))).toBe("word");
  });

  test("password-protected (compound file with an encrypted package) or an old binary format", () => {
    expect(statusOf(compoundFile(["EncryptionInfo", "EncryptedPackage"]))).toBe("protected");
    expect(statusOf(compoundFile(["WordDocument"]))).toBe("unreadable");
  });

  describe("an archive read differently by another reader is refused", () => {
    const parts = partsBytes(docxParts(["x"]));

    test("a comment after the end record (it could hide a second one, which some readers would use)", () => {
      expect(statusOf(rawZip(parts, { comment: END_RECORD }))).toBe("unreadable");
      expect(statusOf(rawZip(parts, { comment: strToU8("bonjour") }))).toBe("unreadable");
    });

    test("an end record signature anywhere outside the entries' data", () => {
      expect(statusOf(rawZip(parts, { gap: END_RECORD }))).toBe("unreadable");
      expect(statusOf(rawZip(parts, { gap: strToU8("rien") }))).toBe("word");
    });

    test("a local header disagreeing with the central directory", () => {
      expect(statusOf(withLocalSize(docx(["x"]), "word/document.xml", 10))).toBe("unreadable");
      expect(statusOf(withDeclaredSize(docx(["x"]), "word/document.xml", 10, false))).toBe("unreadable");
    });

    test("a ZIP64 extra field in a local header", () => {
      const zip64 = Uint8Array.from([0x01, 0x00, 0x10, 0x00, ...Array<number>(16).fill(0)]);
      expect(statusOf(rawZip(parts, { localExtra: zip64 }))).toBe("unreadable");
      expect(statusOf(rawZip(parts, { localExtra: Uint8Array.from([0x55, 0x54, 0x01, 0x00, 0x00]) }))).toBe("word");
    });

    test("a wrong checksum", () => {
      const zip = rawZip(parts);
      const at = Buffer.from(zip).indexOf("word/document.xml") + "word/document.xml".length + 5;
      const tampered = Uint8Array.from(zip);
      tampered[at] = (tampered[at] ?? 0) ^ 0xff;
      expect(statusOf(tampered)).toBe("unreadable");
    });
  });

  describe("zip bombs", () => {
    test(`more than ${OFFICE_LIMITS.totalBytes / 1024 / 1024} MB once inflated, declared or not`, () => {
      expect(statusOf(withDeclaredSize(docx(["x"]), "word/document.xml", OFFICE_LIMITS.totalBytes + 1))).toBe("too_big");
      const big = zipSync({ ...docxParts(["x"]), "word/media/a.bin": new Uint8Array(30 * 1024 * 1024).fill(1), "word/media/b.bin": new Uint8Array(30 * 1024 * 1024).fill(2) }, { level: 1 });
      expect(statusOf(big)).toBe("too_big");
    });

    test("an entry inflating beyond what it declares (local and central agreeing on the lie)", () => {
      const zip = zipSync({ ...docxParts(["x"]), "word/media/a.bin": new Uint8Array(2 * 1024 * 1024).fill(0x41) });
      expect(statusOf(withDeclaredSize(zip, "word/media/a.bin", 1_000))).toBe("too_big");
    });

    test("an implausible ratio, too many entries", () => {
      expect(statusOf(zipSync({ ...docxParts(["x"]), "word/media/z.bin": new Uint8Array(4 * 1024 * 1024) }, { level: 9 }))).toBe("too_big");
      const many = docxParts(["x"]);
      for (let i = 0; i <= OFFICE_LIMITS.entries; i++) many[`word/media/${i}.txt`] = strToU8("x");
      expect(statusOf(zipSync(many, { level: 0 }))).toBe("too_big");
    });
  });
});
