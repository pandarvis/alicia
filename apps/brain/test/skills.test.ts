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
