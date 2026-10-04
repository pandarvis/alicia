import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsStore } from "../src/main/settings-store.ts";
import { SettingsPatch } from "../src/shared/settings.ts";

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
});

describe("SettingsPatch", () => {
  test("only the three settings a window may change, each validated", () => {
    expect(SettingsPatch.safeParse({ showHolo: false }).success).toBe(true);
    expect(SettingsPatch.safeParse({ shortcut: "Ctrl+Shift+K", launchAtStartup: true }).success).toBe(true);
    expect(SettingsPatch.safeParse({ shortcut: "A" }).success).toBe(false);
    expect(SettingsPatch.safeParse({ holoAnchor: { x: 1, y: 1 } }).success).toBe(false);
  });
});
