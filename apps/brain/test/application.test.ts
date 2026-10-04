import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { buildApplication } from "../src/application.ts";
import { parseConfig } from "../src/config.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";

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
