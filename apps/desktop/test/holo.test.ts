import { describe, expect, test } from "vitest";
import { DragDelta, Point } from "../src/shared/holo.ts";

describe("Holo boundary schemas", () => {
  test("a point is a pair of whole screen coordinates within reach", () => {
    expect(Point.safeParse({ x: -1920, y: 40 }).success).toBe(true);
    for (const bad of [{ x: Number.NaN, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }, { x: 1.5, y: 0 }, { x: 0, y: 100_001 }]) {
      expect(Point.safeParse(bad).success).toBe(false);
    }
  });

  test("a drag offset refuses NaN, infinities and absurd distances", () => {
    expect(DragDelta.safeParse({ dx: 12.5, dy: -3 }).success).toBe(true);
    for (const bad of [
      { dx: Number.NaN, dy: 0 }, { dx: 0, dy: Number.NEGATIVE_INFINITY }, { dx: Number.POSITIVE_INFINITY, dy: 0 }, { dx: -100_001, dy: 0 },
    ]) {
      expect(DragDelta.safeParse(bad).success).toBe(false);
    }
  });
});
