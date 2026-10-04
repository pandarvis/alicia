/** Global shortcut used when none was chosen (spec: Ctrl+Alt+A). */
export const DEFAULT_SHORTCUT = "Ctrl+Alt+A";

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const KEY = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/;

function isModifier(part: string): boolean {
  return MODIFIERS.some((modifier) => modifier === part);
}

/**
 * An Electron accelerator we accept: modifiers in canonical order (Ctrl, Alt, Shift, Super) then one key
 * (A–Z, 0–9, F1–F24, Space). Ctrl, Alt or Super is required, except for function keys: Shift+letter would
 * steal ordinary typing.
 */
export function isValidAccelerator(value: string): boolean {
  const parts = value.split("+");
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (key === undefined || !KEY.test(key)) return false;
  if (!modifiers.every(isModifier)) return false;
  const canonical = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  if (canonical.join("+") !== modifiers.join("+")) return false;
  return FUNCTION_KEY.test(key) || modifiers.some((modifier) => modifier !== "Shift");
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

/** Letters and digits from the typed key (layout-aware); the physical key when Ctrl+Alt (AltGr) typed a symbol. */
function keyName(key: string, code: string): string | null {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter;
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return digit;
  if (FUNCTION_KEY.test(code)) return code;
  return code === "Space" ? "Space" : null;
}

/** The accelerator for a key press, or null when it cannot be a shortcut. */
export function acceleratorFromKey(event: KeyLike): string | null {
  const key = keyName(event.key, event.code);
  if (key === null) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");
  const accelerator = [...modifiers, key].join("+");
  return isValidAccelerator(accelerator) ? accelerator : null;
}
