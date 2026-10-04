import { describe, expect, test } from "vitest";
import { parseSurface } from "../src/shared/surface.ts";

describe("parseSurface", () => {
  test("known surfaces", () => {
    expect(parseSurface("main")).toBe("main");
    expect(parseSurface("holo")).toBe("holo");
    expect(parseSurface("spotlight")).toBe("spotlight");
  });

  test("anything else is the main window", () => {
    expect(parseSurface(null)).toBe("main");
    expect(parseSurface("")).toBe("main");
    expect(parseSurface("evil")).toBe("main");
  });
});
