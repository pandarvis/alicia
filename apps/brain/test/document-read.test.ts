import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { AttachmentStore } from "../src/attachments/store.ts";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { callTool } from "../src/engine/fake-engine.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { decodeText, DOCUMENT_TEXT_MAX, documentTools } from "../src/tools/document-read.ts";
import { compoundFile, docx, docxParts, withDeclaredSize, xlsx } from "./documents.ts";
import { createTempDir, createTestClock, createTestDb, createTestTurn, ELODIE, KEVIN, PDF_BYTES, testRequest } from "./helpers.ts";

function setup() {
  const db = createTestDb();
  const clock = createTestClock().clock;
  const store = new AttachmentStore(db, createTempDir(), clock);
  const repository = new ConversationRepository(db, clock);
  const conversation = repository.create("kevin", "Documents");
  const other = repository.create("kevin", "Autre");
  /** Uploads and attaches a file to a conversation of `personId`; returns its id. */
  const attach = async (name: string, bytes: Uint8Array, target = conversation.id, personId = "kevin"): Promise<string> => {
    const uploaded = store.upload(personId, name, bytes);
    if (uploaded.status !== "stored") throw new Error(`refused: ${uploaded.reason}`);
    const claimed = await store.claim(personId, [uploaded.attachment.id], target, repository.addMessage(target, "user", "Regarde"));
    if (claimed.status !== "claimed") throw new Error(claimed.status);
    return uploaded.attachment.id;
  };
  const { turn } = createTestTurn(KEVIN, conversation.id);
  const request = testRequest({ tools: new ToolCatalog([documentTools(store)]).forTurn(turn) });
  return { attach, request, turn, repository, otherId: other.id };
}

const UNREADABLE = { text: "Document illisible (abîmé ou protégé). Dis-le et propose d'en joindre une autre version.", isError: true };
const TOO_BIG = {
  text: "Document refusé : une fois décompressé, il serait anormalement gros (archive piégée ?). Dis-le et propose d'en joindre une autre version.",
  isError: true,
};

describe("document_read", () => {
  test("Word: the text, framed as outside data; the turn becomes untrusted", async () => {
    const { attach, request, turn } = setup();
    const id = await attach("devis.docx", docx(["Devis n° 42", "Total TTC : 1 250,00 €"]));
    const result = await callTool(request, "document_read", { attachment: id });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^<donnees_exterieures id="[0-9a-f]+" source="pièce jointe « devis\.docx »">\n/u);
    expect(result.text).toContain("Devis n° 42");
    expect(result.text).toContain("Total TTC : 1 250,00 €");
    expect(turn.untrusted).toBe(true);
  });

  test("Excel: every sheet as CSV", async () => {
    const { attach, request } = setup();
    const id = await attach("budget.xlsx", xlsx({ Budget: [["Poste", "Montant"], ["Courses", 420]], Notes: [["RAS"]] }));
    const { text } = await callTool(request, "document_read", { attachment: id });
    expect(text).toContain("## Feuille « Budget »\nPoste,Montant\nCourses,420");
    expect(text).toContain("## Feuille « Notes »\nRAS");
  });

  test("the type is read from the archive, not from the extension", async () => {
    const { attach, request } = setup();
    const workbook = await attach("en-fait-un-classeur.docx", xlsx({ Feuille: [["Chiffre", 7]] }));
    expect((await callTool(request, "document_read", { attachment: workbook })).text).toContain("Chiffre,7");
    const letter = await attach("en-fait-une-lettre.xlsx", docx(["Chère Élodie"]));
    expect((await callTool(request, "document_read", { attachment: letter })).text).toContain("Chère Élodie");
    const neither = await attach("autre.docx", zipSync({ "notes.txt": strToU8("rien") }));
    expect(await callTool(request, "document_read", { attachment: neither })).toEqual(UNREADABLE);
  });

  test("text: UTF-8, UTF-16 with its byte order mark, and Windows-1252 (CSV saved by a French Excel)", async () => {
    expect(decodeText(Uint8Array.from([0x44, 0xe9, 0x70, 0x65, 0x6e, 0x73, 0x65, 0x3b, 0x31, 0x32]))).toBe("Dépense;12");
    expect(decodeText(new TextEncoder().encode("﻿Café;3"))).toBe("Café;3");
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x43, 0x00, 0x61, 0x00, 0x66, 0x00, 0xe9, 0x00]))).toBe("Café");
    expect(decodeText(Uint8Array.from([0xfe, 0xff, 0x00, 0x43, 0x00, 0x61, 0x00, 0x66, 0x00, 0xe9]))).toBe("Café");
    expect(decodeText(Uint8Array.from([0x80, 0x20, 0x31, 0x32]))).toBe("€ 12");
    const { attach, request } = setup();
    const id = await attach("liste.csv", Uint8Array.from([0xff, 0xfe, 0x50, 0x00, 0x61, 0x00, 0x69, 0x00, 0x6e, 0x00]));
    expect((await callTool(request, "document_read", { attachment: id })).text).toContain("\nPain\n");
  });

  test("a password-protected Office file says so; an old .doc in disguise is unreadable", async () => {
    const { attach, request } = setup();
    const locked = await attach("salaires.xlsx", compoundFile(["EncryptionInfo", "EncryptedPackage"]));
    expect(await callTool(request, "document_read", { attachment: locked })).toEqual({
      text: "Document protégé par mot de passe : impossible de le lire.", isError: true,
    });
    const old = await attach("vieux.docx", compoundFile(["WordDocument", "1Table"]));
    expect(await callTool(request, "document_read", { attachment: old })).toEqual(UNREADABLE);
  });

  describe("zip bombs are refused before any parser opens them", () => {
    test("declared sizes too big in total", async () => {
      const { attach, request } = setup();
      const id = await attach("bombe.docx", withDeclaredSize(docx(["x"]), "word/document.xml", 150 * 1024 * 1024));
      expect(await callTool(request, "document_read", { attachment: id })).toEqual(TOO_BIG);
    });

    test("an entry inflating beyond what it declares", async () => {
      const { attach, request } = setup();
      const parts = { ...docxParts(["x"]), "word/media/a.bin": new Uint8Array(2 * 1024 * 1024).fill(0x41) };
      const id = await attach("menteur.docx", withDeclaredSize(zipSync(parts), "word/media/a.bin", 1_000));
      expect(await callTool(request, "document_read", { attachment: id })).toEqual(TOO_BIG);
    });

    test("an implausible compression ratio", async () => {
      const { attach, request } = setup();
      const parts = { ...docxParts(["x"]), "word/media/zeros.bin": new Uint8Array(4 * 1024 * 1024) };
      const id = await attach("zeros.docx", zipSync(parts, { level: 9 }));
      expect(await callTool(request, "document_read", { attachment: id })).toEqual(TOO_BIG);
    });

    test("too many entries", async () => {
      const { attach, request } = setup();
      const parts = docxParts(["x"]);
      for (let i = 0; i < 5_001; i++) parts[`word/media/${i}.txt`] = strToU8("x");
      const id = await attach("fourmis.docx", zipSync(parts, { level: 0 }));
      expect(await callTool(request, "document_read", { attachment: id })).toEqual(TOO_BIG);
    });
  });

  test("PDF and images are for Read; another conversation's or person's attachment is not found; a broken file is unreadable", async () => {
    const { attach, request, repository, otherId } = setup();
    const pdf = await attach("facture.pdf", PDF_BYTES);
    expect(await callTool(request, "document_read", { attachment: pdf })).toEqual({
      text: "Ce fichier est une image ou un PDF : lis-le avec Read (chemin donné sous le message).", isError: true,
    });
    const elsewhere = await attach("ailleurs.docx", docx(["Secret"]), otherId);
    const notFound = { text: "Pièce jointe introuvable dans cette conversation.", isError: true };
    expect(await callTool(request, "document_read", { attachment: elsewhere })).toEqual(notFound);
    const theirs = await attach("elodie.docx", docx(["Secret"]), repository.create(ELODIE.id, "À elle").id, ELODIE.id);
    expect(await callTool(request, "document_read", { attachment: theirs })).toEqual(notFound);
    const broken = await attach("abime.docx", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    expect(await callTool(request, "document_read", { attachment: broken })).toEqual(UNREADABLE);
  });

  test("long documents are cut, and say so; an empty one says it is empty", async () => {
    const { attach, request } = setup();
    const id = await attach("long.txt", new TextEncoder().encode("a".repeat(DOCUMENT_TEXT_MAX + 500)));
    const { text } = await callTool(request, "document_read", { attachment: id });
    expect(text).toContain("[… document tronqué : 500 caractères de plus non lus]");
    expect(text.length).toBeLessThan(DOCUMENT_TEXT_MAX + 1_000);
    const empty = await attach("vide.docx", docx([]));
    expect((await callTool(request, "document_read", { attachment: empty })).text).toContain("Le document ne contient aucun texte lisible.");
  });
});
