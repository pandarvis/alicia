import { describe, expect, test } from "vitest";
import { isHiddenLaunch, runOnce } from "../src/main/lifecycle.ts";

describe("lifecycle", () => {
  test("a launch at login asks to stay hidden", () => {
    expect(isHiddenLaunch(["alicia.exe", "--hidden"])).toBe(true);
    expect(isHiddenLaunch(["alicia.exe"])).toBe(false);
    expect(isHiddenLaunch(["alicia.exe", "--hidden-not"])).toBe(false);
  });

  test("the quit cleanup runs once, whichever way of quitting calls it first", () => {
    let runs = 0;
    const cleanup = runOnce(() => {
      runs++;
    });
    cleanup();
    cleanup();
    expect(runs).toBe(1);
  });
});
