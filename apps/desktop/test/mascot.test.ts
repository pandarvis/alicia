import { describe, expect, test } from "vitest";
import { MASCOT_ON_ERROR, MASCOT_SOURCE_FILES, MASCOT_STATES, MascotState } from "../src/shared/mascot.ts";

describe("mascot", () => {
  test("nine states, each mapped to a validated source image", () => {
    expect(MASCOT_STATES).toHaveLength(9);
    expect(Object.keys(MASCOT_SOURCE_FILES).sort()).toEqual([...MASCOT_STATES].sort());
    expect(MASCOT_SOURCE_FILES.idle).toBe("neutre");
    expect(MASCOT_SOURCE_FILES.speaking).toBe("parle");
  });

  test("states are validated at boundaries", () => {
    expect(MascotState.safeParse("idea").success).toBe(true);
    expect(MascotState.safeParse("dancing").success).toBe(false);
  });

  test("mood on a failed turn", () => {
    expect(MASCOT_ON_ERROR.quota).toBe("sleeping");
    expect(MASCOT_ON_ERROR.engine).toBe("error");
    expect(MASCOT_ON_ERROR.unauthenticated).toBeUndefined();
  });
});
