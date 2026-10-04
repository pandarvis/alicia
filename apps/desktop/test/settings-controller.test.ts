import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsController } from "../src/main/settings-controller.ts";
import { Settings, type SettingsSnapshot } from "../src/shared/settings.ts";

function setup(initial: Partial<Settings> = {}, taken: string[] = []) {
  let saved: Settings = { ...Settings.parse({}), ...initial };
  const disk = { failing: false };
  const registered = new Set<string>();
  const loginItems: boolean[] = [];
  const changes: SettingsSnapshot[] = [];
  const controller = new SettingsController(
    {
      load: () => saved,
      save: (settings) => {
        if (disk.failing) throw new Error("EPERM: disk says no");
        saved = settings;
      },
    },
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
  return { controller, registered, loginItems, changes, disk, saved: () => saved };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsController", () => {
  test("start registers the saved shortcut and re-applies the login item", () => {
    const { controller, registered, loginItems } = setup({ launchAtStartup: true });
    controller.start();
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(controller.snapshot.shortcutActive).toBe(true);
    expect(loginItems).toEqual([true]);
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

  test("a patch that cannot be saved changes nothing: new shortcut freed, old kept, login item untouched", () => {
    const { controller, registered, loginItems, changes, disk, saved } = setup();
    controller.start();
    loginItems.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    disk.failing = true;
    const result = controller.update({ shortcut: "Ctrl+Shift+K", launchAtStartup: true, showHolo: false });
    expect(result).toMatchObject({ ok: false, reason: "save_failed" });
    expect(result.snapshot.settings).toMatchObject({ shortcut: "Ctrl+Alt+A", launchAtStartup: false, showHolo: true });
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(loginItems).toEqual([]);
    expect(changes).toEqual([]);
    expect(saved().shortcut).toBe("Ctrl+Alt+A");
    expect(controller.snapshot.shortcutActive).toBe(true);
  });

  test("retrying the inactive shortcut keeps it once registered, even if the save fails", () => {
    const taken = ["Ctrl+Alt+A"];
    const { controller, registered, disk } = setup({}, taken);
    controller.start();
    taken.pop();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    disk.failing = true;
    expect(controller.update({ shortcut: "Ctrl+Alt+A" })).toMatchObject({ ok: false, reason: "save_failed" });
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(controller.snapshot.shortcutActive).toBe(true);
  });

  test("a Holo position that cannot be saved is still followed, and never throws", () => {
    const { controller, changes, disk } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    disk.failing = true;
    expect(() => { controller.setHoloAnchor({ x: 5, y: 6 }); }).not.toThrow();
    expect(controller.snapshot.settings.holoAnchor).toEqual({ x: 5, y: 6 });
    expect(changes).toHaveLength(1);
    expect(logged).toHaveBeenCalledOnce();
  });
});
