import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BAD_URL, createNativeGuard, NOT_AVAILABLE, NOT_READABLE } from "../src/tools/native-guard.ts";
import { UNTRUSTED_REMINDER } from "../src/tools/untrusted.ts";
import { createTempDir, createTestTurn, KEVIN } from "./helpers.ts";

const CONV = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SIGNAL = new AbortController().signal;

/** A data folder (attachments, database) and a workspace whose .claude/ holds the skills and a settings file. */
function setup() {
  const root = createTempDir();
  const attachmentsDir = join(root, "data", "attachments", CONV);
  const otherDir = join(root, "data", "attachments", OTHER);
  const claudeDir = join(root, "workspace", ".claude");
  const skillsDir = join(claudeDir, "skills");
  for (const dir of [attachmentsDir, otherDir, join(skillsDir, "lire-un-document")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(attachmentsDir, "a.pdf"), "%PDF-1.7");
  writeFileSync(join(otherDir, "b.pdf"), "%PDF-1.7");
  writeFileSync(join(skillsDir, "lire-un-document", "SKILL.md"), "---\nname: lire-un-document\n---\n");
  writeFileSync(join(claudeDir, "settings.json"), "{}");
  writeFileSync(join(root, "data", "alicia.db"), "db");
  const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { attachmentsDir, skillsDir });
  return { guard: createNativeGuard(turn), turn, asked, root, attachmentsDir, otherDir, skillsDir, claudeDir };
}

describe("native guard", () => {
  test("WebSearch and Skill are allowed; any other built-in tool is not", async () => {
    const { guard } = setup();
    expect(await guard.check("WebSearch", { query: "piscine" }, SIGNAL)).toEqual({ allow: true });
    expect(await guard.check("Skill", { skill: "lire-un-document" }, SIGNAL)).toEqual({ allow: true });
    for (const tool of ["Bash", "Write", "Edit", "Glob", "Grep", "Agent", "NotebookEdit", "mcp__other__x"]) {
      expect(await guard.check(tool, {}, SIGNAL), tool).toEqual({ allow: false, reason: NOT_AVAILABLE });
    }
    expect(guard.reminder("WebSearch", {})).toBeUndefined();
  });

  test("Read: a skill file is allowed and the turn stays trusted", async () => {
    const { guard, turn, skillsDir } = setup();
    expect(await guard.check("Read", { file_path: join(skillsDir, "lire-un-document", "SKILL.md") }, SIGNAL)).toEqual({ allow: true });
    expect(turn.untrusted).toBe(false);
  });

  test("Read: this conversation's attachment is allowed, and the turn becomes untrusted", async () => {
    const { guard, turn, attachmentsDir } = setup();
    expect(await guard.check("Read", { file_path: join(attachmentsDir, "a.pdf"), pages: "1-3" }, SIGNAL)).toEqual({ allow: true });
    expect(turn.untrusted).toBe(true);
  });

  test("Read: anything else is refused (another conversation, the database, the settings beside the skills, bad input)", async () => {
    const { guard, turn, root, otherDir, claudeDir, skillsDir } = setup();
    for (const input of [
      { file_path: join(otherDir, "b.pdf") },
      { file_path: join(root, "data", "alicia.db") },
      { file_path: join(claudeDir, "settings.json") },
      { file_path: join(skillsDir, "..", "settings.json") },
      { file_path: skillsDir },
      { file_path: "SKILL.md" },
      { path: "x" },
      { file_path: 42 },
      "x",
      null,
    ]) {
      expect(await guard.check("Read", input, SIGNAL), JSON.stringify(input)).toEqual({ allow: false, reason: NOT_READABLE });
    }
    expect(turn.untrusted).toBe(false);
  });

  test("Read: a conversation without attachments reaches no attachment folder", async () => {
    const root = createTempDir();
    const { turn } = createTestTurn(KEVIN, CONV, "refused", {
      attachmentsDir: join(root, "attachments", CONV), skillsDir: join(root, "skills"),
    });
    const guard = createNativeGuard(turn);
    expect(await guard.check("Read", { file_path: join(root, "attachments", CONV, "a.pdf") }, SIGNAL))
      .toEqual({ allow: false, reason: NOT_READABLE });
  });
});

const FETCH = (url: string) => ({ url, prompt: "Résume" });
const REFUSED_FETCH = "Page non ouverte : la personne a refusé. Ne réessaie pas sans qu'elle le demande.";

describe("WebFetch", () => {
  test("trusted turn: any web page, no question; the page then makes the turn untrusted", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    const guard = createNativeGuard(turn);
    expect(await guard.check("WebFetch", FETCH("https://example.com/a"), SIGNAL)).toEqual({ allow: true });
    expect(asked).toEqual([]);
    expect(turn.untrusted).toBe(true);
  });

  test("untrusted turn: an address from the person's message goes through", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { userText: "Regarde https://meteo.fr/paris" });
    turn.markUntrusted();
    expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://meteo.fr/paris/"), SIGNAL)).toEqual({ allow: true });
    expect(asked).toEqual([]);
  });

  test("untrusted turn: any other address asks first; no → refused", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { userText: "Lis mon document https://meteo.fr/paris" });
    turn.markUntrusted();
    const guard = createNativeGuard(turn);
    for (const url of [
      "https://evil.example/?d=souvenirs",
      // Look-alikes of the person's address: other host, credentials, other query, longer path.
      "https://meteo.fr@evil.example/paris",
      "https://meteo.fr.evil.example/paris",
      "https://meteo.fr/paris?d=souvenirs",
      "https://meteo.fr/paris/souvenirs",
    ]) {
      expect(await guard.check("WebFetch", FETCH(url), SIGNAL), url).toEqual({ allow: false, reason: REFUSED_FETCH });
    }
    expect(asked[0]).toEqual({ tool: "WebFetch", summary: expect.stringContaining("https://evil.example/?d=souvenirs") as string });
    expect(asked).toHaveLength(5);
  });

  test("untrusted turn: yes → allowed", async () => {
    const { turn } = createTestTurn(KEVIN, CONV, "approved");
    turn.markUntrusted();
    expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: true });
  });

  test("untrusted turn, no answer or turn over: refused", async () => {
    for (const [outcome, reason] of [
      ["expired", "Page non ouverte : pas de réponse à la demande de confirmation."],
      ["cancelled", "Page non ouverte : demande de confirmation annulée."],
    ] as const) {
      const { turn } = createTestTurn(KEVIN, CONV, outcome);
      turn.markUntrusted();
      expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: false, reason });
    }
  });

  test("not a web address: refused without asking", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved");
    for (const input of [FETCH("file:///C:/Windows/win.ini"), FETCH("javascript:alert(1)"), { prompt: "x" }, "x"]) {
      expect(await createNativeGuard(turn).check("WebFetch", input, SIGNAL)).toEqual({ allow: false, reason: BAD_URL });
    }
    expect(asked).toEqual([]);
  });

  test("reminder after WebFetch and after reading an attachment, not after a skill file", () => {
    const { guard, attachmentsDir, skillsDir } = setup();
    expect(guard.reminder("WebFetch", FETCH("https://example.com"))).toBe(UNTRUSTED_REMINDER);
    expect(guard.reminder("Read", { file_path: join(attachmentsDir, "a.pdf") })).toBe(UNTRUSTED_REMINDER);
    expect(guard.reminder("Read", { file_path: join(skillsDir, "lire-un-document", "SKILL.md") })).toBeUndefined();
    expect(guard.reminder("WebSearch", { query: "x" })).toBeUndefined();
  });
});
