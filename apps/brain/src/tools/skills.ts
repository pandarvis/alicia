import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Skills of the workspace: each folder holding a SKILL.md, sorted. */
export function listSkills(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}
