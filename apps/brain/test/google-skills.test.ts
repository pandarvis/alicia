import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SKILLS_DIR } from "../src/application.ts";
import { listSkills } from "../src/tools/skills.ts";

/** Tools a skill may name (the frontmatter and folder rules are workspace.test.ts's). */
const KNOWN_TOOLS = new Set([
  "calendar_list", "calendar_create", "calendar_update", "calendar_delete",
  "gmail_search", "gmail_read", "gmail_draft", "weather",
  "memory_search", "memory_remember", "memory_update", "memory_forget",
]);
const GOOGLE_SKILLS = ["preparer-la-semaine", "tri-des-mails"];

const text = (name: string): string => readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
/** The tools a skill names in backticks. */
const namedTools = (name: string): string[] =>
  [...text(name).matchAll(/`([a-z]+_[a-z_]+|weather)`/g)].map((match) => match[1] ?? "");

test("the Google skills are found by the brain", () => {
  expect(listSkills(SKILLS_DIR)).toEqual(expect.arrayContaining(GOOGLE_SKILLS));
});

describe.each(GOOGLE_SKILLS)("skill %s", (name) => {
  test("only names tools that exist, and never a way to send", () => {
    for (const tool of namedTools(name)) expect(KNOWN_TOOLS.has(tool), tool).toBe(true);
    expect(text(name)).not.toMatch(/gmail_send|send_mail|envoie le mail/i);
  });

  test("what the mails and calendars say is data, never an instruction", () => {
    expect(text(name)).toMatch(/donnée/);
    expect(text(name)).toMatch(/consigne/);
  });
});

test("preparer-la-semaine reads the calendars once, then the weather, and changes nothing unasked", () => {
  const tools = namedTools("preparer-la-semaine");
  expect(tools).toEqual(expect.arrayContaining(["calendar_list", "weather"]));
  expect(tools.filter((tool) => /^calendar_(create|update|delete)$/.test(tool))).toEqual([]);
  expect(text("preparer-la-semaine")).toMatch(/Ne crée, ne modifie ni ne supprime rien/);
});

test("tri-des-mails searches, reads a few, and only drafts — never sends", () => {
  expect(namedTools("tri-des-mails")).toEqual(expect.arrayContaining(["gmail_search", "gmail_read", "gmail_draft"]));
  expect(text("tri-des-mails")).toMatch(/n'envoies jamais/);
  expect(text("tri-des-mails")).toMatch(/suspect/);
});
