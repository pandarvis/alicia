import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { construireApplication } from "../src/application.ts";
import { lireConfig } from "../src/config.ts";
import { FauxMoteur } from "../src/engine/fake-engine.ts";

let dossier: string | undefined;
afterEach(() => {
  if (dossier !== undefined) rmSync(dossier, { recursive: true, force: true });
});

test("assemble base, personnes et serveur dans le dossier de données", async () => {
  dossier = mkdtempSync(join(tmpdir(), "alicia-"));
  const config = lireConfig(`
dossierDonnees: ${JSON.stringify(dossier)}
personnes: [{ id: kevin, nom: Kévin }]
moteur: { mode: abonnement }
`);
  const appli = await construireApplication(config, new FauxMoteur(() => []));
  expect(appli.appairage.genererCode("kevin")).toMatch(/^\d{6}$/);
  const rep = await appli.serveur.inject({ method: "GET", url: "/sante" });
  expect(rep.statusCode).toBe(200);
  await appli.fermer();
});
