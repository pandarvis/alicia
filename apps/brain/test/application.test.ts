import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { AttachmentStore } from "../src/attachments/store.ts";
import { buildApplication, toolProviders } from "../src/application.ts";
import { parseConfig } from "../src/config.ts";
import { callTool, FakeEngine } from "../src/engine/fake-engine.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import type { GoogleClient } from "../src/google/google-client.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { createGoogleFixture } from "./google-fixture.ts";
import { createTempDir, createTestClock, createTestDb, createTestMemory, createTestTurn, KEVIN, testRequest } from "./helpers.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

test("wires the database, people and server in the data directory", async () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-"));
  const config = parseConfig(`
dataDir: ${JSON.stringify(dir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const app = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
  expect(app.pairing.generateCode("kevin")).toMatch(/^\d{6}$/);
  const res = await app.server.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  await app.close();
});

test("the nightly job writes its backup into <dataDir>/backups", async () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-"));
  const config = parseConfig(`
dataDir: ${JSON.stringify(dir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const app = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
  const path = await app.maintenance.runNow();
  await app.close();
  expect(dirname(path)).toBe(join(dir, "backups"));
  expect(readdirSync(join(dir, "backups"))).toEqual([basename(path)]);
  const copy = new Database(path, { readonly: true });
  const ids = copy.prepare("SELECT id FROM people").pluck().all();
  copy.close();
  expect(ids).toEqual(["kevin"]);
});

test("startup purges memories forgotten for over 30 days and keeps the rest", async () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-"));
  const config = parseConfig(`
dataDir: ${JSON.stringify(dir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const first = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
  const ids: string[] = [];
  for (const text of ["Rendez-vous chez le dentiste mardi", "Kévin adore les lasagnes"]) {
    const result = await first.memory.remember({ personId: "kevin", scope: "personal", kind: "fact", text, source: "conversation" });
    if (result.status !== "created") throw new Error("not created");
    expect(first.memory.forget("kevin", result.memory.id)).toBe(true);
    ids.push(result.memory.id);
  }
  await first.close();

  // Age the first forgotten memory beyond the retention period, behind the brain's back.
  const raw = new Database(join(dir, "alicia.db"));
  raw.prepare("UPDATE memories SET forgotten_at = ? WHERE id = ?").run(Date.now() - 40 * 24 * 3_600_000, ids[0]);
  raw.close();

  const second = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
  await second.close();
  const check = new Database(join(dir, "alicia.db"));
  const left = check.prepare("SELECT id FROM memories").pluck().all();
  check.close();
  expect(left).toEqual([ids[1]]);
});

test("starts with a relative dataDir (as in alicia.config.example.yaml), serving its updates folder", async (context) => {
  dir = mkdtempSync(join(tmpdir(), "alicia-"));
  const relativeDir = relative(process.cwd(), dir);
  // The temp folder on another drive than the repository (Windows): no relative path leads there.
  if (isAbsolute(relativeDir)) context.skip("the temp folder is on another drive");
  const ORPHAN = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";
  mkdirSync(join(dir, "attachments", ORPHAN), { recursive: true });
  const config = parseConfig(`
dataDir: ${JSON.stringify(relativeDir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const app = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
  // A folder left by a deletion that could not remove it is swept at startup.
  expect(existsSync(join(dir, "attachments", ORPHAN))).toBe(false);
  // The attachments' folder is absolute too: its paths go to Alicia and to the SDK (whose cwd is the workspace).
  const conversationDir = app.attachments.dirOf("3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192");
  expect(isAbsolute(conversationDir)).toBe(true);
  expect(conversationDir.startsWith(dir)).toBe(true);
  writeFileSync(join(dir, "updates", "latest.yml"), "version: 0.2.0\n");
  const res = await app.server.inject({ method: "GET", url: "/updates/latest.yml" });
  await app.close();
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("version: 0.2.0");
});

test("tool providers: documents always, weather only when the home is configured, through the given fetch", async () => {
  const db = createTestDb();
  const clock = createTestClock().clock;
  const urls: string[] = [];
  const fakeFetch: typeof fetch = (input) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.reject(new Error("offline"));
  };
  const parts = {
    memory: createTestMemory(db, clock), attachments: new AttachmentStore(db, createTempDir(), clock), fetch: fakeFetch, google: undefined,
  };
  const tools = (yaml: string) =>
    new ToolCatalog(toolProviders(parseConfig(yaml), parts)).forTurn(createTestTurn(KEVIN, "11111111-1111-4111-8111-111111111111").turn);
  const base = "people: [{ id: kevin, name: Kévin }]\nengine: { mode: subscription }\n";
  expect(tools(base).map((t) => t.name)).not.toContain("weather");
  expect(tools(base).map((t) => t.name)).toContain("document_read");
  const withHome = tools(`${base}home: { latitude: 48.85, longitude: 2.35 }\n`);
  expect(withHome.map((t) => t.name)).toContain("weather");
  await callTool(testRequest({ tools: withHome }), "weather", {});
  expect(urls).toHaveLength(1);
});

test("tool providers: Google only when a Google client is given", () => {
  const db = createTestDb();
  const clock = createTestClock().clock;
  const { client } = createGoogleFixture();
  const base = parseConfig("people: [{ id: kevin, name: Kévin }]\nengine: { mode: subscription }\n");
  const parts = { memory: createTestMemory(db, clock), attachments: new AttachmentStore(db, createTempDir(), clock), fetch };
  const names = (google: GoogleClient | undefined) =>
    new ToolCatalog(toolProviders(base, { ...parts, google }))
      .forTurn(createTestTurn(KEVIN, "11111111-1111-4111-8111-111111111111").turn)
      .map((t) => t.name);
  expect(names(undefined)).not.toContain("gmail_read");
  expect(names(client)).toEqual(expect.arrayContaining(["calendar_list", "gmail_draft"]));
});
