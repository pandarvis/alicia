import { expect, test } from "vitest";
import { NOM_PROTOCOLE } from "../src/index.ts";

test("le paquet protocole se charge", () => {
  expect(NOM_PROTOCOLE).toBe("alicia");
});
