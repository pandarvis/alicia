import { describe, expect, test } from "vitest";
import {
  acceleratorFromKey, captureShortcut, isValidAccelerator, type KeyLike, SHORTCUT_REFUSAL_MESSAGES,
} from "../src/shared/accelerator.ts";

function press(key: string, code: string, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

describe("isValidAccelerator", () => {
  test("two modifiers or Windows with a key, F1–F12 with a modifier, F13–F24 alone, in canonical order", () => {
    for (const accelerator of [
      "Ctrl+Alt+A", "Ctrl+Shift+K", "Alt+Shift+Space", "Super+1", "Super+Space", "Ctrl+Alt+num5", "Ctrl+F9",
      "Alt+F12", "F13", "F24", "Shift+F13", "Ctrl+Alt+Shift+Super+Z",
    ]) {
      expect(isValidAccelerator(accelerator), accelerator).toBe(true);
    }
  });

  test("refuses keys that would steal ordinary typing or window commands", () => {
    for (const accelerator of [
      "A", "Shift+A", "Ctrl+A", "Alt+A", "Ctrl+1", "Alt+Space", "Ctrl+Space", "num5", "Ctrl+num5", "F9", "Shift+F10",
      "Alt+F4",
    ]) {
      expect(isValidAccelerator(accelerator), accelerator).toBe(false);
    }
  });

  test("refuses malformed accelerators", () => {
    for (const accelerator of [
      "Ctrl+", "Ctrl+Alt", "Ctrl+Ctrl+A", "Alt+Ctrl+A", "Ctrl+Alt+Enter", "Cmd+Alt+A", "", "Ctrl+Alt+a", "F25",
      "Ctrl+Alt+num", "Ctrl+Alt+num10",
    ]) {
      expect(isValidAccelerator(accelerator), accelerator).toBe(false);
    }
  });
});

describe("acceleratorFromKey", () => {
  test("the letter comes from the typed key, so an AZERTY A stays A", () => {
    expect(acceleratorFromKey(press("a", "KeyQ", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+A");
    expect(acceleratorFromKey(press("K", "KeyK", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
  });

  test("the top-row digits of AZERTY fall back to the physical key without AltGr", () => {
    expect(acceleratorFromKey(press("&", "Digit1", { metaKey: true }))).toBe("Super+1");
    expect(acceleratorFromKey(press("&", "Digit1", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
  });

  test("numpad digits stay numpad keys", () => {
    expect(acceleratorFromKey(press("5", "Numpad5", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+num5");
    expect(acceleratorFromKey(press("+", "NumpadAdd", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  test("function keys and space", () => {
    expect(acceleratorFromKey(press("F13", "F13"))).toBe("F13");
    expect(acceleratorFromKey(press("F9", "F9", { ctrlKey: true }))).toBe("Ctrl+F9");
    expect(acceleratorFromKey(press(" ", "Space", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+Space");
  });

  test("null when the combination is not usable", () => {
    expect(acceleratorFromKey(press("K", "KeyK", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("k", "KeyK"))).toBeNull();
    expect(acceleratorFromKey(press("k", "KeyK", { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("F9", "F9"))).toBeNull();
    expect(acceleratorFromKey(press(" ", "Space", { altKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("F4", "F4", { altKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("Enter", "Enter", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
  });
});

describe("captureShortcut", () => {
  test("a usable key press gives its accelerator", () => {
    expect(captureShortcut(press("K", "KeyK", { ctrlKey: true, shiftKey: true }))).toEqual({ ok: true, accelerator: "Ctrl+Shift+K" });
  });

  test("Ctrl+Alt (AltGr) typing a character is refused: it would steal that character", () => {
    expect(captureShortcut(press("€", "KeyE", { ctrlKey: true, altKey: true }))).toEqual({ ok: false, reason: "types_character" });
    expect(captureShortcut(press("@", "Digit0", { ctrlKey: true, altKey: true }))).toEqual({ ok: false, reason: "types_character" });
    expect(captureShortcut(press("Dead", "BracketLeft", { ctrlKey: true, altKey: true }))).toEqual({ ok: false, reason: "types_character" });
  });

  test("Ctrl+Alt on a key whose AltGr layer is empty falls back to the physical key, when the layout says so", () => {
    // French AZERTY: AltGr+& types nothing, so the key reports its base character.
    const azerty = new Map([["Digit1", "&"], ["Digit0", "à"], ["KeyE", "e"]]);
    expect(captureShortcut(press("&", "Digit1", { ctrlKey: true, altKey: true }), azerty))
      .toEqual({ ok: true, accelerator: "Ctrl+Alt+1" });
    // AltGr produced something new: still refused.
    expect(captureShortcut(press("@", "Digit0", { ctrlKey: true, altKey: true }), azerty))
      .toEqual({ ok: false, reason: "types_character" });
    expect(captureShortcut(press("€", "KeyE", { ctrlKey: true, altKey: true }), azerty))
      .toEqual({ ok: false, reason: "types_character" });
  });

  test("without the keyboard layout, Ctrl+Alt on a character stays refused (it may be an AltGr character)", () => {
    expect(captureShortcut(press("&", "Digit1", { ctrlKey: true, altKey: true })))
      .toEqual({ ok: false, reason: "types_character" });
    expect(captureShortcut(press("&", "Digit1", { ctrlKey: true, altKey: true }), new Map()))
      .toEqual({ ok: false, reason: "types_character" });
  });

  test("anything else is not a shortcut", () => {
    expect(captureShortcut(press("k", "KeyK", { ctrlKey: true }))).toEqual({ ok: false, reason: "not_a_shortcut" });
  });

  test("each refusal is explained in French", () => {
    expect(SHORTCUT_REFUSAL_MESSAGES.types_character).toBe("Cette combinaison tape un caractère sur ce clavier.");
    expect(SHORTCUT_REFUSAL_MESSAGES.not_a_shortcut).toContain("F13 à F24");
  });
});
