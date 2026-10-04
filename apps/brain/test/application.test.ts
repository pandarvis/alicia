import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApplication } from "../src/application.ts";
import { parseConfig } from "../src/config.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

test("wires the database, people and server in the data directory", async () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-"));
  const config = parseConfig(`
dossierDonnees: ${JSON.stringify(dir)}
personnes: [{ id: kevin, name: Kévin }]
moteur: { mode: abonnement }
`);
  const app = await buildApplication(config, new FakeEngine(() => []));
  expect(app.pairing.generateCode("kevin")).toMatch(/^\d{6}$/);
  const res = await app.server.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  await app.close();
});
