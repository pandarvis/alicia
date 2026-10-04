/** Global shortcut used when none was chosen (spec: Ctrl+Alt+A). */
export const DEFAULT_SHORTCUT = "Ctrl+Alt+A";

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
/** F13–F24 exist on no ordinary keyboard row: nothing types with them, so they may be used alone. */
const SPARE_FUNCTION_KEY = /^F(?:1[3-9]|2[0-4])$/;
const KEY = /^(?:[A-Z]|[0-9]|num[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/;
/** Window commands Windows itself relies on (Alt+F4 closes; Alt+Space already fails the two-modifier rule). */
const RESERVED = new Set(["Alt+F4"]);

function isModifier(part: string): boolean {
  return MODIFIERS.some((modifier) => modifier === part);
}

/**
 * An Electron accelerator we accept: modifiers in canonical order (Ctrl, Alt, Shift, Super) then one key
 * (A–Z, 0–9, num0–num9, F1–F24, Space). So that a global shortcut never steals ordinary typing or a window
 * command:
 * - a letter, digit or Space needs two modifiers, or Super (Ctrl+C, Alt+letter menus, Shift+letter stay free);
 * - F1–F12 need Ctrl, Alt or Super (Shift+F10 is the context menu); F13–F24 may be used alone;
 * - Alt+F4 is refused (Alt+Space, the window menu, already lacks a second modifier).
 */
export function isValidAccelerator(value: string): boolean {
  const parts = value.split("+");
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (key === undefined || !KEY.test(key)) return false;
  if (!modifiers.every(isModifier)) return false;
  const canonical = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  if (canonical.join("+") !== modifiers.join("+")) return false;
  if (RESERVED.has(value)) return false;
  if (SPARE_FUNCTION_KEY.test(key)) return true;
  if (FUNCTION_KEY.test(key)) return modifiers.some((modifier) => modifier !== "Shift");
  return modifiers.includes("Super") || modifiers.length >= 2;
}

/** The parts of a keydown event used to capture a shortcut. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type ShortcutRefusal = "types_character" | "not_a_shortcut";

export type ShortcutCapture = { ok: true; accelerator: string } | { ok: false; reason: ShortcutRefusal };

/** Why a key press cannot become the shortcut, for the Réglages screen. */
export const SHORTCUT_REFUSAL_MESSAGES: Readonly<Record<ShortcutRefusal, string>> = {
  types_character: "Cette combinaison tape un caractère sur ce clavier.",
  not_a_shortcut:
    "Choisis deux touches parmi Ctrl, Alt et Maj avec une lettre ou un chiffre, la touche Windows avec une touche, "
    + "Ctrl, Alt ou Windows avec F1 à F12, ou une touche F13 à F24.",
};

/** A key that typed a character (or a dead key, the start of one), as opposed to a named key (Enter, F5…). */
function typesCharacter(key: string): boolean {
  return key === "Dead" || /^\S$/u.test(key);
}

/**
 * The keyboard layout: physical key code → the character it types without any modifier (`Digit1` → `&` on
 * French AZERTY), as given by Chromium's `navigator.keyboard.getLayoutMap()`.
 */
export type KeyboardLayout = ReadonlyMap<string, string>;

type KeyName = { ok: true; name: string } | { ok: false; reason: ShortcutRefusal };

/**
 * Ctrl+Alt is AltGr on many layouts. When the key reports its own base character, AltGr typed nothing on it
 * (French AZERTY: AltGr+& is empty), so the combination steals nothing. A keydown event alone cannot tell the
 * base character of a key (`&` could be AltGr's), hence the layout map; without it, the safe answer is "it types".
 */
function altGrTypesNothing(event: KeyLike, layout: KeyboardLayout | undefined): boolean {
  return layout?.get(event.code) === event.key;
}

/**
 * Letters and digits from the typed key (layout-aware: an AZERTY A stays A); the physical key for the AZERTY
 * top-row digits (& é " …) and numpad digits. With Ctrl+Alt, which is AltGr on many layouts, a key that
 * typed a symbol (€, @…) is refused: the shortcut would steal that character.
 */
function keyName(event: KeyLike, layout: KeyboardLayout | undefined): KeyName {
  const { key, code } = event;
  const numpad = /^Numpad([0-9])$/.exec(code)?.[1];
  if (numpad !== undefined) return { ok: true, name: `num${numpad}` };
  if (code.startsWith("Numpad")) return { ok: false, reason: "not_a_shortcut" };
  if (/^[a-z0-9]$/i.test(key)) return { ok: true, name: key.toUpperCase() };
  if (event.ctrlKey && event.altKey && typesCharacter(key) && !altGrTypesNothing(event, layout)) {
    return { ok: false, reason: "types_character" };
  }
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return { ok: true, name: letter };
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return { ok: true, name: digit };
  if (FUNCTION_KEY.test(code)) return { ok: true, name: code };
  return code === "Space" ? { ok: true, name: "Space" } : { ok: false, reason: "not_a_shortcut" };
}

/**
 * The accelerator for a key press, or why it cannot be a shortcut. `layout` (when the page could read it) lets
 * Ctrl+Alt on a key without an AltGr character fall back to the physical key.
 */
export function captureShortcut(event: KeyLike, layout?: KeyboardLayout): ShortcutCapture {
  const key = keyName(event, layout);
  if (!key.ok) return key;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");
  const accelerator = [...modifiers, key.name].join("+");
  return isValidAccelerator(accelerator) ? { ok: true, accelerator } : { ok: false, reason: "not_a_shortcut" };
}

/** The accelerator for a key press, or null when it cannot be a shortcut. */
export function acceleratorFromKey(event: KeyLike): string | null {
  const capture = captureShortcut(event);
  return capture.ok ? capture.accelerator : null;
}
