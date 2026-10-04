import { describe, expect, test } from "vitest";
import { acceleratorFromKey, isValidAccelerator, type KeyLike } from "../src/shared/accelerator.ts";

function press(key: string, code: string, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

describe("isValidAccelerator", () => {
  test("modifier + key, in canonical order", () => {
    for (const accelerator of ["Ctrl+Alt+A", "Ctrl+Shift+K", "Alt+Space", "Super+1", "F9", "Shift+F12", "Ctrl+Alt+Shift+Super+Z"]) {
      expect(isValidAccelerator(accelerator)).toBe(true);
    }
  });

  test("refuses a bare key, Shift alone, unknown keys, duplicates and odd order", () => {
    for (const accelerator of ["A", "Shift+A", "Ctrl+", "Ctrl+Alt", "Ctrl+Ctrl+A", "Alt+Ctrl+A", "Ctrl+Enter", "Cmd+A", "", "Ctrl+a", "F25"]) {
      expect(isValidAccelerator(accelerator)).toBe(false);
    }
  });
});

describe("acceleratorFromKey", () => {
  test("the letter comes from the typed key, so an AZERTY A stays A", () => {
    expect(acceleratorFromKey(press("a", "KeyQ", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+A");
    expect(acceleratorFromKey(press("K", "KeyK", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
  });

  test("falls back to the physical key when Ctrl+Alt (AltGr) types a symbol", () => {
    expect(acceleratorFromKey(press("€", "KeyE", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+E");
  });

  test("digits of the AZERTY top row, function keys, space", () => {
    expect(acceleratorFromKey(press("&", "Digit1", { ctrlKey: true }))).toBe("Ctrl+1");
    expect(acceleratorFromKey(press("F9", "F9"))).toBe("F9");
    expect(acceleratorFromKey(press(" ", "Space", { altKey: true }))).toBe("Alt+Space");
  });

  test("null when the combination is not usable", () => {
    expect(acceleratorFromKey(press("K", "KeyK", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("k", "KeyK"))).toBeNull();
    expect(acceleratorFromKey(press("Enter", "Enter", { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
  });
});
