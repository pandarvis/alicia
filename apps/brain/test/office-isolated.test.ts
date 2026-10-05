import { expect, test } from "vitest";
import { officeTextIsolated } from "../src/tools/office-isolated.ts";
import { compoundFile, docx, xlsx } from "./documents.ts";

test("a document is read in a worker thread", async () => {
  expect(await officeTextIsolated(docx(["Bonjour Kévin"]))).toEqual({ status: "text", text: "Bonjour Kévin\n\n" });
  const sheet = await officeTextIsolated(xlsx({ Budget: [["Poste", "Montant"], ["Courses", 420]] }));
  expect(sheet).toEqual({ status: "text", text: "## Feuille « Budget »\nPoste,Montant\nCourses,420" });
  expect(await officeTextIsolated(compoundFile(["EncryptedPackage"]))).toEqual({ status: "protected" });
});

test("past its deadline, the worker is stopped and the document refused", async () => {
  expect(await officeTextIsolated(docx(["x"]), { timeoutMs: 1 })).toEqual({ status: "too_slow" });
});

test("a document needing more memory than the worker has is refused as too big; the brain goes on", async () => {
  const rows = Array.from({ length: 3_000 }, (_, i) => [`ligne ${i}`, "x".repeat(200), i]);
  expect(await officeTextIsolated(xlsx({ Gros: rows }), { heapMb: 4 })).toEqual({ status: "too_big" });
  expect((await officeTextIsolated(docx(["encore là"]))).status).toBe("text");
});
