import { expect, test } from "vitest";
import { FauxMoteur } from "../src/moteur/faux-moteur.ts";
import type { EvenementMoteur, RequeteMoteur } from "../src/moteur/moteur.ts";

const REQUETE: RequeteMoteur = { prompt: "x", sessionId: undefined, modele: "sonnet", consigneSysteme: "c" };

async function collecter(source: AsyncIterable<EvenementMoteur>) {
  const sortie: EvenementMoteur[] = [];
  for await (const e of source) sortie.push(e);
  return sortie;
}

test("rejoue les scénarios dans l'ordre, le dernier se répète, et note les requêtes", async () => {
  const moteur = new FauxMoteur(
    () => [{ type: "texte", texte: "un" }],
    () => [{ type: "texte", texte: "deux" }],
  );
  const signal = new AbortController().signal;
  expect(await collecter(moteur.executer(REQUETE, signal))).toEqual([{ type: "texte", texte: "un" }]);
  expect(await collecter(moteur.executer(REQUETE, signal))).toEqual([{ type: "texte", texte: "deux" }]);
  expect(await collecter(moteur.executer(REQUETE, signal))).toEqual([{ type: "texte", texte: "deux" }]);
  expect(moteur.requetes).toHaveLength(3);
});
