import { describe, expect, test } from "vitest";
import { throttle } from "../src/renderer/src/lib/throttle.ts";

describe("throttle", () => {
  test("runs at once, then at most once per interval", () => {
    let now = 1000;
    let runs = 0;
    const typing = throttle(() => { runs++; }, 300, () => now);
    typing();
    typing();
    now += 299;
    typing();
    expect(runs).toBe(1);
    now += 1;
    typing();
    typing();
    expect(runs).toBe(2);
  });
});
