import { describe, expect, test } from "vitest";
import { SettingsController } from "../src/main/settings-controller.ts";
import { Settings, type SettingsSnapshot } from "../src/shared/settings.ts";

function setup(initial: Partial<Settings> = {}, taken: string[] = []) {
  let saved: Settings = { ...Settings.parse({}), ...initial };
  const registered = new Set<string>();
  const loginItems: boolean[] = [];
  const changes: SettingsSnapshot[] = [];
  const controller = new SettingsController(
    { load: () => saved, save: (settings) => { saved = settings; } },
    {
      registerShortcut: (accelerator) => {
        if (taken.includes(accelerator) || registered.has(accelerator)) return false;
        registered.add(accelerator);
        return true;
      },
      unregisterShortcut: (accelerator) => { registered.delete(accelerator); },
      setLoginItem: (open) => { loginItems.push(open); },
      onChange: (snapshot) => { changes.push(snapshot); },
    },
  );
  return { controller, registered, loginItems, changes, saved: () => saved };
}

describe("SettingsController", () => {
  test("start registers the saved shortcut", () => {
    const { controller, registered } = setup();
    controller.start();
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(controller.snapshot.shortcutActive).toBe(true);
  });

  test("a shortcut held by another app at start is reported, not fatal", () => {
    const { controller } = setup({}, ["Ctrl+Alt+A"]);
    controller.start();
    expect(controller.snapshot.shortcutActive).toBe(false);
  });

  test("a new shortcut is registered, the old one freed, then saved and announced", () => {
    const { controller, registered, changes, saved } = setup();
    controller.start();
    const result = controller.update({ shortcut: "Ctrl+Shift+K" });
    expect(result.ok).toBe(true);
    expect([...registered]).toEqual(["Ctrl+Shift+K"]);
    expect(saved().shortcut).toBe("Ctrl+Shift+K");
    expect(changes.at(-1)?.settings.shortcut).toBe("Ctrl+Shift+K");
  });

  test("a shortcut taken by another app is refused and the old one stays", () => {
    const { controller, registered, saved } = setup({}, ["Ctrl+Shift+K"]);
    controller.start();
    const result = controller.update({ shortcut: "Ctrl+Shift+K" });
    expect(result).toMatchObject({ ok: false, reason: "shortcut_unavailable" });
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(saved().shortcut).toBe("Ctrl+Alt+A");
  });

  test("choosing the same shortcut again retries it when it was not active", () => {
    const taken = ["Ctrl+Alt+A"];
    const { controller, registered } = setup({}, taken);
    controller.start();
    taken.pop();
    expect(controller.update({ shortcut: "Ctrl+Alt+A" }).ok).toBe(true);
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(controller.snapshot.shortcutActive).toBe(true);
  });

  test("launch at startup touches the login item only when it changes", () => {
    const { controller, loginItems } = setup();
    controller.update({ launchAtStartup: false });
    controller.update({ launchAtStartup: true });
    controller.update({ launchAtStartup: true });
    expect(loginItems).toEqual([true]);
  });

  test("showing the Holo and its position are saved", () => {
    const { controller, saved, changes } = setup();
    controller.update({ showHolo: false });
    controller.setHoloAnchor({ x: 100, y: 200 });
    expect(saved()).toMatchObject({ showHolo: false, holoAnchor: { x: 100, y: 200 } });
    expect(changes).toHaveLength(2);
  });
});
