import { describe, expect, test } from "vitest";
import { RecordedState, RecordingOs } from "../src/main/recording-os.ts";
import { trayMenuItems } from "../src/main/tray-menu.ts";

describe("RecordingOs", () => {
  test("records shortcuts, login item, notifications and tray, and lets the test drive them", () => {
    const os = new RecordingOs();
    const hooks = os.hooks();
    let triggered = 0;
    let clicked = 0;
    let trayClicks = 0;
    const actions: string[] = [];
    expect(os.registerShortcut("Ctrl+Alt+A", () => { triggered++; })).toBe(true);
    os.setLoginItem(true);
    os.notify({ title: "Alicia", body: "Coucou", onClick: () => { clicked++; } });
    os.createTray(trayMenuItems({ paired: true, showHolo: true, launchAtStartup: false, updateReady: false }), (action) => {
      actions.push(action);
    }, () => { trayClicks++; });

    const state = RecordedState.parse(hooks.state());
    expect(state.shortcuts).toEqual(["Ctrl+Alt+A"]);
    expect(state.loginItem).toBe(true);
    expect(state.notifications).toEqual([{ title: "Alicia", body: "Coucou" }]);
    expect(state.tray.map((item) => item.id)).toEqual(["open", "toggle-holo", "toggle-startup", "quit"]);

    hooks.triggerShortcut();
    hooks.clickNotification(0);
    hooks.trayAction("toggle-holo");
    hooks.trayClick();
    expect([triggered, clicked, trayClicks, actions]).toEqual([1, 1, 1, ["toggle-holo"]]);
    expect(() => { hooks.trayAction("format-disk"); }).toThrow();
  });

  test("an unregistered shortcut is gone", () => {
    const os = new RecordingOs();
    os.registerShortcut("Ctrl+Alt+A", () => undefined);
    os.unregisterShortcut("Ctrl+Alt+A");
    expect(os.hooks().state().shortcuts).toEqual([]);
    expect(() => { os.hooks().triggerShortcut(); }).toThrow();
  });
});
