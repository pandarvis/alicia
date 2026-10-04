import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsStore } from "../src/main/settings-store.ts";
import {
  Settings, SETTINGS_UPDATE_MESSAGES, SettingsPatch, SettingsSnapshot, SettingsUpdateResult,
} from "../src/shared/settings.ts";

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** A rename that fails with `codes` (one per call) before behaving normally. */
function flakyRename(codes: string[]) {
  const calls: string[] = [];
  const rename = (from: string, to: string): void => {
    const code = codes[calls.length];
    calls.push(code ?? "ok");
    if (code !== undefined) throw fsError(code);
    renameSync(from, to);
  };
  return { rename, calls };
}

const DEFAULTS = { shortcut: "Ctrl+Alt+A", launchAtStartup: false, showHolo: true, holoAnchor: null };
const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alicia-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  return { dir, path, store: new SettingsStore(path) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("no file yet: the defaults", () => {
    expect(setup().store.load()).toEqual(DEFAULTS);
  });

  test("saves and loads back, leaving no temporary file", () => {
    const { dir, store } = setup();
    const settings = { shortcut: "Ctrl+Shift+K", launchAtStartup: true, showHolo: false, holoAnchor: { x: -1200, y: 40 } };
    store.save(settings);
    expect(store.load()).toEqual(settings);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("saving broken settings is a bug: refused, the previous file is left as it was", () => {
    const { dir, path, store } = setup();
    store.save({ ...DEFAULTS, showHolo: false });
    expect(() => { store.save({ ...DEFAULTS, shortcut: "Ctrl+C" }); }).toThrow();
    expect(new SettingsStore(path).load()).toEqual({ ...DEFAULTS, showHolo: false });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("a broken field falls back to its default, the others are kept", () => {
    const { path, store } = setup();
    writeFileSync(path, JSON.stringify({ shortcut: "Ctrl+Hyper+A", launchAtStartup: true, showHolo: "yes", holoAnchor: { x: 10, y: 20 } }));
    expect(store.load()).toEqual({ shortcut: "Ctrl+Alt+A", launchAtStartup: true, showHolo: true, holoAnchor: { x: 10, y: 20 } });
  });

  test("unreadable JSON, or JSON that is not an object: the defaults", () => {
    const { path, store } = setup();
    writeFileSync(path, "{ not json");
    expect(store.load()).toEqual(DEFAULTS);
    writeFileSync(path, "[1, 2]");
    expect(store.load()).toEqual(DEFAULTS);
  });

  test("a file briefly locked (antivirus, indexer) is retried", () => {
    const { dir, path } = setup();
    const flaky = flakyRename(["EPERM", "EBUSY"]);
    const store = new SettingsStore(path, { rename: flaky.rename });
    store.save({ ...Settings.parse({}), showHolo: false });
    expect(flaky.calls).toEqual(["EPERM", "EBUSY", "ok"]);
    expect(store.load().showHolo).toBe(false);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("a file locked for good fails after three tries and leaves no temporary file", () => {
    const { dir, path } = setup();
    const flaky = flakyRename(["EACCES", "EACCES", "EACCES", "EACCES"]);
    const store = new SettingsStore(path, { rename: flaky.rename });
    expect(() => { store.save(Settings.parse({})); }).toThrow("EACCES");
    expect(flaky.calls).toHaveLength(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("other errors are not retried", () => {
    const { path } = setup();
    const flaky = flakyRename(["ENOSPC"]);
    expect(() => { new SettingsStore(path, { rename: flaky.rename }).save(Settings.parse({})); }).toThrow("ENOSPC");
    expect(flaky.calls).toEqual(["ENOSPC"]);
  });
});

describe("SettingsSnapshot (main to windows)", () => {
  test("strict: a broken field is refused, not replaced by its default", () => {
    const settings = Settings.parse({});
    expect(SettingsSnapshot.safeParse({ settings, shortcutActive: true }).success).toBe(true);
    expect(SettingsSnapshot.safeParse({ settings: { ...settings, shortcut: "A" }, shortcutActive: true }).success).toBe(false);
    expect(SettingsSnapshot.safeParse({ settings: { ...settings, showHolo: "yes" }, shortcutActive: true }).success).toBe(false);
    expect(SettingsSnapshot.safeParse({ settings: { ...settings, extra: 1 }, shortcutActive: true }).success).toBe(false);
  });

  test("an update that could not be saved says so, in French", () => {
    const snapshot = { settings: Settings.parse({}), shortcutActive: true };
    expect(SettingsUpdateResult.safeParse({ ok: false, reason: "save_failed", snapshot }).success).toBe(true);
    expect(SETTINGS_UPDATE_MESSAGES.save_failed).toBe("Impossible d'enregistrer ce réglage sur cet ordinateur ; rien n'a changé.");
    expect(Object.keys(SETTINGS_UPDATE_MESSAGES).sort()).toEqual(["invalid", "save_failed", "shortcut_unavailable"]);
  });
});

describe("SettingsPatch", () => {
  test("only the three settings a window may change, each validated", () => {
    expect(SettingsPatch.safeParse({ showHolo: false }).success).toBe(true);
    expect(SettingsPatch.safeParse({ shortcut: "Ctrl+Shift+K", launchAtStartup: true }).success).toBe(true);
    expect(SettingsPatch.safeParse({ shortcut: "A" }).success).toBe(false);
    expect(SettingsPatch.safeParse({ holoAnchor: { x: 1, y: 1 } }).success).toBe(false);
  });
});
