import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createNativeGuard, NOT_AVAILABLE, NOT_READABLE } from "../src/tools/native-guard.ts";
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
