import { describe, expect, test } from "vitest";
import { ATTACHMENT_MAX_BYTES, AttachmentSummary, attachmentTypeOf, checkAttachment, formatSize } from "../src/index.ts";

describe("attachments", () => {
  test("type from the extension, whatever its case", () => {
    expect(attachmentTypeOf("Facture.PDF")).toEqual({ extension: ".pdf", kind: "pdf", mediaType: "application/pdf" });
    expect(attachmentTypeOf("budget.xlsx")?.kind).toBe("excel");
    expect(attachmentTypeOf("lettre.docx")?.kind).toBe("word");
    expect(attachmentTypeOf("photo.jpeg")?.kind).toBe("image");
    expect(attachmentTypeOf("notes.csv")?.kind).toBe("text");
    for (const name of ["virus.exe", "ancien.doc", "ancien.xls", "sans-extension", ".pdf", "archive.zip"]) {
      expect(attachmentTypeOf(name), name).toBeUndefined();
    }
  });

  test("check before upload: unsupported, empty, too large", () => {
    expect(checkAttachment("a.exe", 10)).toEqual({ ok: false, reason: "unsupported" });
    expect(checkAttachment("a.pdf", 0)).toEqual({ ok: false, reason: "empty" });
    expect(checkAttachment("a.pdf", ATTACHMENT_MAX_BYTES + 1)).toEqual({ ok: false, reason: "too_large" });
    expect(checkAttachment("a.pdf", ATTACHMENT_MAX_BYTES)).toMatchObject({ ok: true, type: { kind: "pdf" } });
    expect(ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  test("sizes in French", () => {
    expect(formatSize(512)).toBe("512 o");
    expect(formatSize(12_800)).toBe("13 Ko");
    expect(formatSize(1_258_291)).toBe("1,2 Mo");
  });

  test("a summary: id, display name, kind and size", () => {
    const summary = { id: "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", name: "Facture.pdf", kind: "pdf", size: 1200 };
    expect(AttachmentSummary.parse(summary)).toEqual(summary);
    expect(AttachmentSummary.safeParse({ ...summary, kind: "exe" }).success).toBe(false);
    expect(AttachmentSummary.safeParse({ ...summary, size: 0 }).success).toBe(false);
    expect(AttachmentSummary.safeParse({ ...summary, name: "" }).success).toBe(false);
  });
});
