import { expect, test } from "vitest";
import { ouvrirBase } from "../src/db/open.ts";
import { personnes } from "../src/db/schema.ts";

test("ouvre une base en mémoire avec les tables migrées", () => {
  const base = ouvrirBase(":memory:");
  base.insert(personnes).values({ id: "kevin", nom: "Kévin" }).run();
  expect(base.select().from(personnes).all()).toEqual([{ id: "kevin", nom: "Kévin" }]);
});

test("les clés étrangères sont actives", () => {
  const base = ouvrirBase(":memory:");
  expect(() =>
    base.$client
      .prepare("INSERT INTO conversations (id, personne_id, titre, cree_le, maj_le) VALUES ('c', 'personne', 't', 0, 0)")
      .run(),
  ).toThrow(/FOREIGN KEY/);
});
