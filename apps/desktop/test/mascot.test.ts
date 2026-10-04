import { describe, expect, test } from "vitest";
import { MASCOT_SOURCE_FILES, MASCOT_STATES } from "../src/renderer/src/lib/mascot.ts";

describe("mascot", () => {
  test("nine states, each mapped to a validated source image", () => {
    expect(MASCOT_STATES).toHaveLength(9);
    expect(Object.keys(MASCOT_SOURCE_FILES).sort()).toEqual([...MASCOT_STATES].sort());
    expect(MASCOT_SOURCE_FILES.idle).toBe("neutre");
    expect(MASCOT_SOURCE_FILES.speaking).toBe("parle");
  });
});
