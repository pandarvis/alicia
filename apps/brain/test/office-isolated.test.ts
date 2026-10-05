import { expect, test, vi } from "vitest";
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

const FAILING = new URL("./workers/failing-worker.ts", import.meta.url);
const SILENT = new URL("./workers/silent-worker.ts", import.meta.url);

test("a worker that fails is logged by its error's name and code only, never its message (it may quote the document)", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await officeTextIsolated(docx(["x"]), { entry: FAILING })).toEqual({ status: "unreadable" });
    expect(errors).toHaveBeenCalledOnce();
    const logged = errors.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).toContain("ERR_TEST_PARSER");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("4521");
  } finally {
    errors.mockRestore();
  }
});

test("a document too big for the worker is not logged: it is the document, not a failure", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const rows = Array.from({ length: 3_000 }, (_, i) => [`ligne ${i}`, "x".repeat(200), i]);
    expect(await officeTextIsolated(xlsx({ Gros: rows }), { heapMb: 4 })).toEqual({ status: "too_big" });
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});

test("the worker lives no longer than the turn: an abort stops it at once", async () => {
  const turn = new AbortController();
  const started = Date.now();
  const reading = officeTextIsolated(docx(["x"]), { entry: SILENT, signal: turn.signal, timeoutMs: 20_000 });
  setTimeout(() => {
    turn.abort();
  }, 50);
  expect(await reading).toEqual({ status: "cancelled" });
  expect(Date.now() - started).toBeLessThan(5_000);
  // A turn already over starts nothing.
  expect(await officeTextIsolated(docx(["x"]), { signal: turn.signal })).toEqual({ status: "cancelled" });
});
