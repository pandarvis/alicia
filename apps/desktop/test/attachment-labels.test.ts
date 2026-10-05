import { expect, test } from "vitest";
import { ACCEPTED_FILES, refusalText, TOO_MANY } from "../src/renderer/src/lib/attachment-labels.ts";

test("clear French refusals, before anything is sent", () => {
  expect(refusalText("film.mp4", 10, "unsupported")).toBe(
    "« film.mp4 » n'est pas pris en charge : images, PDF, Word (.docx), Excel (.xlsx) et texte (.txt, .csv).",
  );
  expect(refusalText("scan.pdf", 32 * 1024 * 1024, "too_large")).toBe("« scan.pdf » est trop gros (32 Mo) : 25 Mo au maximum.");
  expect(refusalText("vide.txt", 0, "empty")).toBe("« vide.txt » est vide.");
  expect(refusalText("a.pdf", 10, "too_many")).toBe(
    "« a.pdf » n'a pas été joint : trop de fichiers attendent déjà d'être envoyés. Envoie ou retire-les, puis réessaie.",
  );
  expect(refusalText("a.pdf", 10, "failed")).toBe("« a.pdf » n'a pas pu être envoyé à Alicia : retire-le et réessaie.");
  expect(TOO_MANY).toBe("10 pièces jointes au maximum par message.");
  expect(ACCEPTED_FILES).toBe(".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx,.txt,.csv");
});
