import { describe, expect, test } from "vitest";
import { neighbourId } from "../src/renderer/src/lib/memory-focus.ts";

describe("neighbourId", () => {
  test("the next one, or the previous one at the end", () => {
    expect(neighbourId(["a", "b", "c"], "a")).toBe("b");
    expect(neighbourId(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourId(["a", "b", "c"], "c")).toBe("b");
  });

  test("none left, or not in the list", () => {
    expect(neighbourId(["a"], "a")).toBeNull();
    expect(neighbourId([], "a")).toBeNull();
    expect(neighbourId(["a", "b"], "z")).toBe("a");
  });
});
