import { expect, test } from "vitest";
import { openDb } from "../src/db/open.ts";
import { findPerson, syncPeople } from "../src/identity/people.ts";
import { KEVIN } from "./helpers.ts";

test("syncs the people from the config (creation then rename)", () => {
  const db = openDb(":memory:");
  syncPeople(db, [KEVIN]);
  syncPeople(db, [{ id: "kevin", name: "Kév" }]);
  expect(findPerson(db, "kevin")).toEqual({ id: "kevin", name: "Kév" });
});

test("unknown person: undefined", () => {
  expect(findPerson(openDb(":memory:"), "nobody")).toBeUndefined();
});
