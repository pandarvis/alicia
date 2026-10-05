import { describe, expect, test, vi } from "vitest";
import { SETTINGS_MESSAGES, SettingsScreen, type SettingsPorts } from "../src/renderer/src/lib/settings-screen.svelte.ts";
import type { KeyboardLayout, KeyLike } from "../src/shared/accelerator.ts";
import { Settings, type SettingsPatch, type SettingsSnapshot, type SettingsUpdateResult } from "../src/shared/settings.ts";

function snapshot(settings: Partial<Settings> = {}, shortcutActive = true): SettingsSnapshot {
  return { settings: { ...Settings.parse({}), ...settings }, shortcutActive };
}

function key(name: string, code: string, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { key: name, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

function setup(
  answer?: (patch: SettingsPatch, current: SettingsSnapshot) => Promise<SettingsUpdateResult>,
  layout?: KeyboardLayout,
) {
  let current = snapshot();
  const patches: SettingsPatch[] = [];
  const calls: string[] = [];
  const listeners: ((next: SettingsSnapshot) => void)[] = [];
  const ports: SettingsPorts = {
    get: () => Promise.resolve(current),
    update: (patch) => {
      patches.push(patch);
      calls.push("update");
      if (answer !== undefined) return answer(patch, current);
      current = snapshot({
        ...current.settings,
        ...(patch.shortcut !== undefined ? { shortcut: patch.shortcut } : {}),
        ...(patch.launchAtStartup !== undefined ? { launchAtStartup: patch.launchAtStartup } : {}),
        ...(patch.showHolo !== undefined ? { showHolo: patch.showHolo } : {}),
      });
      return Promise.resolve({ ok: true, snapshot: current });
    },
    onChange: (listener) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
    suspendShortcut: (suspended) => {
      calls.push(suspended ? "suspend" : "resume");
      return Promise.resolve();
    },
  };
  const screen = new SettingsScreen(ports, () => Promise.resolve(layout));
  return { screen, patches, calls, push: (next: SettingsSnapshot) => { for (const listener of [...listeners]) listener(next); } };
}

async function started(screen: SettingsScreen): Promise<void> {
  screen.start();
  await vi.waitFor(() => { expect(screen.snapshot).not.toBeNull(); });
}

describe("SettingsScreen", () => {
  test("loads the settings and follows changes made elsewhere (tray menu)", async () => {
    const { screen, push } = setup();
    await started(screen);
    expect(screen.snapshot?.settings.shortcut).toBe("Ctrl+Alt+A");
    push(snapshot({ showHolo: false }));
    expect(screen.snapshot?.settings.showHolo).toBe(false);
  });

  test("switches launch at startup and the Holo", async () => {
    const { screen, patches } = setup();
    await started(screen);
    await screen.toggleStartup();
    await screen.toggleHolo();
    expect(patches).toEqual([{ launchAtStartup: true }, { showHolo: false }]);
    expect(screen.snapshot?.settings).toMatchObject({ launchAtStartup: true, showHolo: false });
  });

  test("capturing a shortcut: Escape cancels, a modifier alone waits, a bare letter explains, Ctrl+Shift+K saves", async () => {
    const { screen, patches } = setup();
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("Escape", "Escape"));
    expect(screen.capturing).toBe(false);

    screen.startCapture();
    await screen.captureKey(key("Control", "ControlLeft", { ctrlKey: true }));
    expect([screen.capturing, screen.shortcutError]).toEqual([true, null]);
    await screen.captureKey(key("k", "KeyK"));
    expect([screen.capturing, screen.shortcutError]).toEqual([true, SETTINGS_MESSAGES.not_a_shortcut]);
    await screen.captureKey(key("€", "KeyE", { ctrlKey: true, altKey: true }));
    expect([screen.capturing, screen.shortcutError]).toEqual([true, SETTINGS_MESSAGES.types_character]);
    await screen.captureKey(key("K", "KeyK", { ctrlKey: true, shiftKey: true }));
    expect(screen.capturing).toBe(false);
    expect(patches).toEqual([{ shortcut: "Ctrl+Shift+K" }]);
    expect(screen.snapshot?.settings.shortcut).toBe("Ctrl+Shift+K");
    expect(screen.shortcutError).toBeNull();
  });

  test("with the keyboard layout, Ctrl+Alt on an AZERTY digit without AltGr character is accepted", async () => {
    const { screen, patches } = setup(undefined, new Map([["Digit1", "&"], ["Digit0", "à"]]));
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("@", "Digit0", { ctrlKey: true, altKey: true }));
    expect(screen.shortcutError).toBe(SETTINGS_MESSAGES.types_character);
    await screen.captureKey(key("&", "Digit1", { ctrlKey: true, altKey: true }));
    expect(patches).toEqual([{ shortcut: "Ctrl+Alt+1" }]);
  });

  test("a key pressed after the capture was cancelled is ignored", async () => {
    const { screen, patches } = setup();
    await started(screen);
    screen.startCapture();
    screen.cancelCapture();
    await screen.captureKey(key("K", "KeyK", { ctrlKey: true, shiftKey: true }));
    expect(patches).toEqual([]);
  });

  test("the current shortcut is set aside during the capture, and back before the new one is saved", async () => {
    const { screen, calls } = setup();
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("Escape", "Escape"));
    screen.startCapture();
    await screen.captureKey(key("K", "KeyK", { ctrlKey: true, shiftKey: true }));
    expect(calls).toEqual(["suspend", "resume", "suspend", "resume", "update"]);
  });

  test("cancelling clears the refusal; leaving the screen while capturing brings the shortcut back", async () => {
    const { screen, calls } = setup();
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("k", "KeyK"));
    expect(screen.shortcutError).not.toBeNull();
    screen.cancelCapture();
    expect(screen.shortcutError).toBeNull();
    screen.startCapture();
    screen.stop();
    expect(calls).toEqual(["suspend", "resume", "suspend", "resume"]);
  });

  test("a shortcut held by another app is explained, the old one stays", async () => {
    const { screen } = setup((_patch, current) => Promise.resolve({ ok: false, reason: "shortcut_unavailable", snapshot: current }));
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("K", "KeyK", { ctrlKey: true, shiftKey: true }));
    expect(screen.shortcutError).toBe(SETTINGS_MESSAGES.shortcut_unavailable);
    expect(screen.error).toBeNull();
    expect(screen.snapshot?.settings.shortcut).toBe("Ctrl+Alt+A");
  });

  test("a setting the main process could not write to disk is explained", async () => {
    const { screen } = setup((_patch, current) => Promise.resolve({ ok: false, reason: "save_failed", snapshot: current }));
    await started(screen);
    await screen.toggleHolo();
    expect(screen.error).toBe(SETTINGS_MESSAGES.save_failed);
  });

  test("a setting that cannot be saved is explained", async () => {
    const { screen } = setup(() => Promise.reject(new Error("IPC down")));
    await started(screen);
    await screen.toggleHolo();
    expect(screen.error).toBe(SETTINGS_MESSAGES.failed);
    expect(screen.saving).toBe(false);
  });

  test("reset brings Ctrl+Alt+A back", async () => {
    const { screen, patches } = setup();
    await started(screen);
    await screen.resetShortcut();
    expect(patches).toEqual([{ shortcut: "Ctrl+Alt+A" }]);
  });
});
