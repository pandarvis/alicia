import type { KeyboardLayout } from "../../../shared/accelerator.ts";

/**
 * The keyboard layout from Chromium's Keyboard API (`navigator.keyboard.getLayoutMap()`, missing from
 * TypeScript's DOM types, hence read and checked by hand): physical key code → the character it types without
 * any modifier. Undefined when the API is missing or refuses; shortcut capture then stays on the safe side.
 */
export async function readKeyboardLayout(nav: object = navigator): Promise<KeyboardLayout | undefined> {
  const keyboard: unknown = Reflect.get(nav, "keyboard");
  if (typeof keyboard !== "object" || keyboard === null) return undefined;
  const getLayoutMap: unknown = Reflect.get(keyboard, "getLayoutMap");
  if (typeof getLayoutMap !== "function") return undefined;
  try {
    const map: unknown = await Reflect.apply(getLayoutMap, keyboard, []);
    if (typeof map !== "object" || map === null) return undefined;
    const forEach: unknown = Reflect.get(map, "forEach");
    if (typeof forEach !== "function") return undefined;
    const layout = new Map<string, string>();
    Reflect.apply(forEach, map, [(value: unknown, code: unknown) => {
      if (typeof value === "string" && typeof code === "string") layout.set(code, value);
    }]);
    return layout;
  } catch {
    return undefined;
  }
}
