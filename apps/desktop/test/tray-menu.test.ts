import { describe, expect, test } from "vitest";
import { trayMenuItems } from "../src/main/tray-menu.ts";

const BASE = { paired: true, showHolo: true, launchAtStartup: false, updateReady: false };

describe("trayMenuItems", () => {
  test("open, Holo, launch at startup, then quit", () => {
    const items = trayMenuItems(BASE);
    expect(items.map((item) => [item.id, item.label, item.checked])).toEqual([
      ["open", "Ouvrir Alicia", null],
      ["toggle-holo", "Afficher l'Holo", true],
      ["toggle-startup", "Lancer au démarrage", false],
      ["separator", "", null],
      ["quit", "Quitter Alicia", null],
    ]);
  });

  test("the Holo needs a paired device", () => {
    expect(trayMenuItems({ ...BASE, paired: false }).find((item) => item.id === "toggle-holo")?.enabled).toBe(false);
  });

  test("a downloaded update offers a restart", () => {
    const ids = trayMenuItems({ ...BASE, updateReady: true }).map((item) => item.id);
    expect(ids).toEqual(["open", "toggle-holo", "toggle-startup", "install-update", "separator", "quit"]);
  });
});
