import { describe, expect, test } from "vitest";
import { readKeyboardLayout } from "../src/renderer/src/lib/keyboard-layout.ts";

describe("readKeyboardLayout", () => {
  test("reads Chromium's layout map: physical key to base character", async () => {
    const nav = { keyboard: { getLayoutMap: () => Promise.resolve(new Map([["Digit1", "&"], ["KeyQ", "a"]])) } };
    expect(await readKeyboardLayout(nav)).toEqual(new Map([["Digit1", "&"], ["KeyQ", "a"]]));
  });

  test("no Keyboard API, or a failing one: no layout", async () => {
    expect(await readKeyboardLayout({})).toBeUndefined();
    expect(await readKeyboardLayout({ keyboard: {} })).toBeUndefined();
    expect(await readKeyboardLayout({ keyboard: { getLayoutMap: () => Promise.reject(new Error("denied")) } })).toBeUndefined();
  });
});
