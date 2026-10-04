import { describe, expect, test } from "vitest";
import { ftsQuery, fuse } from "../src/memory/ranking.ts";

describe("ftsQuery", () => {
  test("quotes accent-free words and ORs them", () => {
    expect(ftsQuery("Quel est son plat préféré ?")).toBe('"quel" OR "est" OR "son" OR "plat" OR "prefere"');
  });
  test("neutralizes FTS5 syntax", () => {
    expect(ftsQuery('lasagnes" OR * NEAR(')).toBe('"lasagnes" OR "or" OR "near"');
  });
  test("repeated words appear once", () => {
    expect(ftsQuery("lasagnes LASAGNES lasagnes")).toBe('"lasagnes"');
  });
  test("nothing searchable → null", () => {
    expect(ftsQuery("? !")).toBeNull();
  });
});

describe("fuse (reciprocal rank fusion)", () => {
  test("items ranked well in both lists come first", () => {
    expect(fuse([["a", "b", "c"], ["b", "a", "d"]])).toEqual(["a", "b", "c", "d"]);
  });
  test("an item present in one list only still counts", () => {
    expect(fuse([["x"], []])).toEqual(["x"]);
  });
  test("agreement beats a single first place", () => {
    expect(fuse([["solo", "both"], ["other", "both"]])[0]).toBe("both");
  });
});
