import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AttachmentStore } from "../src/attachments/store.ts";
import { SKILLS_DIR, toolProviders } from "../src/application.ts";
import { parseConfig } from "../src/config.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { listSkills } from "../src/tools/skills.ts";
import { createGoogleFixture } from "./google-fixture.ts";
import { createTempDir, createTestClock, createTestDb, createTestMemory, createTestTurn, KEVIN } from "./helpers.ts";

/**
 * Tools a skill may name: every tool of the brain at its fullest (home and Google configured), as a turn gets them.
 * Built inside a test (the Google fixture checks what reached Google when the test ends). The frontmatter and folder
 * rules are workspace.test.ts's.
 */
function knownTools(): Set<string> {
  const db = createTestDb();
  const clock = createTestClock().clock;
  const config = parseConfig("people: [{ id: kevin, name: Kévin }]\nengine: { mode: subscription }\nhome: { latitude: 48.85, longitude: 2.35 }\n");
  const providers = toolProviders(config, {
    memory: createTestMemory(db, clock), attachments: new AttachmentStore(db, createTempDir(), clock), fetch,
    google: createGoogleFixture().client,
  });
  const turn = createTestTurn(KEVIN, "11111111-1111-4111-8111-111111111111").turn;
  return new Set(new ToolCatalog(providers).forTurn(turn).map((tool) => tool.name));
}
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
    const known = knownTools();
    expect(known.has("calendar_list") && known.has("weather")).toBe(true);
    for (const tool of namedTools(name)) expect(known.has(tool), tool).toBe(true);
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
