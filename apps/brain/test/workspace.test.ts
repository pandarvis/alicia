import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SKILLS_DIR, WORKSPACE_DIR } from "../src/application.ts";

test("the workspace holds nothing the SDK would load besides skills", () => {
  for (const file of [
    ".mcp.json", "CLAUDE.md", "CLAUDE.local.md", ".claude/settings.json", ".claude/settings.local.json",
    ".claude/CLAUDE.md", ".claude/rules", ".claude/agents", ".claude/commands", ".claude/hooks", ".claude/plugins",
  ]) {
    expect(existsSync(join(WORKSPACE_DIR, file)), file).toBe(false);
  }
  expect(SKILLS_DIR).toBe(join(WORKSPACE_DIR, ".claude", "skills"));
});
