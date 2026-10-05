import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listSkills } from "../src/tools/skills.ts";
import { createTempDir } from "./helpers.ts";

test("a skill is a folder holding a SKILL.md; missing folder → none", () => {
  const dir = createTempDir();
  for (const name of ["b-skill", "a-skill"]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "notes.md"), "");
  expect(listSkills(dir)).toEqual(["a-skill", "b-skill"]);
  expect(listSkills(join(dir, "absent"))).toEqual([]);
});

test("a skill may neither widen its tools nor run hooks: the brain refuses to start with one", () => {
  for (const [key, frontmatter] of [
    ["allowed-tools", "name: x\nallowed-tools: Bash"],
    ["hooks", "name: x\nhooks:\n  PreToolUse: []"],
    ["hooks", "name: x\nHooks: {}"],
  ] as const) {
    const dir = createTempDir();
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "SKILL.md"), `---\n${frontmatter}\n---\nCorps\n`);
    expect(() => listSkills(dir), key).toThrow(new RegExp(`x.*${key}`, "iu"));
  }
});

test("the same words in the body of a skill are harmless", () => {
  const dir = createTempDir();
  mkdirSync(join(dir, "x"));
  writeFileSync(join(dir, "x", "SKILL.md"), "---\r\nname: x\r\ndescription: y\r\n---\r\nallowed-tools: rien\nhooks: rien\n");
  expect(listSkills(dir)).toEqual(["x"]);
});
