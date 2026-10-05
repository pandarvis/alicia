import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { SKILLS_DIR, WORKSPACE_DIR } from "../src/application.ts";
import { listSkills } from "../src/tools/skills.ts";

test("the workspace holds nothing the SDK would load besides skills", () => {
  for (const file of [
    ".mcp.json", "CLAUDE.md", "CLAUDE.local.md", ".claude/settings.json", ".claude/settings.local.json",
    ".claude/CLAUDE.md", ".claude/rules", ".claude/agents", ".claude/commands", ".claude/hooks", ".claude/plugins",
  ]) {
    expect(existsSync(join(WORKSPACE_DIR, file)), file).toBe(false);
  }
  expect(SKILLS_DIR).toBe(join(WORKSPACE_DIR, ".claude", "skills"));
});

test("no folder above the workspace, up to the repository root, brings skills, commands or agents", () => {
  const brainDir = dirname(WORKSPACE_DIR);
  const repoRoot = dirname(dirname(brainDir));
  expect(existsSync(join(repoRoot, "pnpm-workspace.yaml"))).toBe(true);
  for (const dir of [brainDir, dirname(brainDir), repoRoot]) {
    for (const kind of ["skills", "commands", "agents"]) {
      const path = join(dir, ".claude", kind);
      expect(existsSync(path), path).toBe(false);
    }
  }
});

const SKILLS = ["lire-un-document", "ranger-un-souvenir", "verifier-avant-d-agir"];
/** Strict: an `allowed-tools`, `hooks` (or any other key) would grant or change something; refused. */
const Frontmatter = z.strictObject({
  name: z.string(),
  description: z.string().min(40).max(1024).regex(/^[^<>]*$/u),
});

test("the workspace ships exactly Alicia's three skills, and nothing else under .claude", () => {
  expect(listSkills(SKILLS_DIR)).toEqual(SKILLS);
  expect(readdirSync(join(WORKSPACE_DIR, ".claude"))).toEqual(["skills"]);
});

test.each(SKILLS)("%s: name = folder, French description, no extra key, instructions only", (name) => {
  const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(text);
  if (match === null) throw new Error("frontmatter missing");
  const front = Frontmatter.parse(parse(match[1] ?? ""));
  expect(front.name).toBe(name);
  expect((match[2] ?? "").trim().length).toBeGreaterThan(300);
  expect(readdirSync(join(SKILLS_DIR, name))).toEqual(["SKILL.md"]);
});
