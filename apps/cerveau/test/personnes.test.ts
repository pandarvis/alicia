import { expect, test } from "vitest";
import { ouvrirBase } from "../src/base/ouvrir.ts";
import { synchroniserPersonnes, trouverPersonne } from "../src/identites/personnes.ts";
import { KEVIN } from "./aides.ts";

test("synchronise les personnes de la config (création puis renommage)", () => {
  const base = ouvrirBase(":memory:");
  synchroniserPersonnes(base, [KEVIN]);
  synchroniserPersonnes(base, [{ id: "kevin", nom: "Kév" }]);
  expect(trouverPersonne(base, "kevin")).toEqual({ id: "kevin", nom: "Kév" });
});

test("personne inconnue : undefined", () => {
  expect(trouverPersonne(ouvrirBase(":memory:"), "personne")).toBeUndefined();
});
