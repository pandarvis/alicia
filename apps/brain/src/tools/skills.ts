import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** Frontmatter keys a skill may not carry: they would widen its tools or run commands around it. */
const FORBIDDEN_KEYS = ["allowed-tools", "hooks"];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/** The forbidden keys a SKILL.md declares (any case); an unreadable frontmatter counts as forbidden. */
export function forbiddenSkillKeys(skillMd: string): string[] {
  const block = FRONTMATTER.exec(skillMd)?.[1];
  if (block === undefined) return [];
  let data: unknown;
  try {
    data = parse(block);
  } catch {
    return ["unreadable frontmatter"];
  }
  if (typeof data !== "object" || data === null) return [];
  return Object.keys(data).filter((key) => FORBIDDEN_KEYS.includes(key.toLowerCase()));
}

/**
 * Skills of the workspace: each folder holding a SKILL.md, sorted. A skill declaring `allowed-tools` or `hooks` is
 * a programming error found at startup: the brain refuses to start rather than load it.
 */
export function listSkills(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const forbidden = forbiddenSkillKeys(readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"));
    if (forbidden.length > 0) throw new Error(`Skill ${name}: forbidden frontmatter (${forbidden.join(", ")})`);
  }
  return names;
}
