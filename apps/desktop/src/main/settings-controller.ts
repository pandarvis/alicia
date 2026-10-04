import type { Point } from "../shared/holo.ts";
import type { Settings, SettingsPatch, SettingsSnapshot, SettingsUpdateResult } from "../shared/settings.ts";

export interface SettingsPersistence {
  load(): Settings;
  save(settings: Settings): void;
}

export interface SettingsPorts {
  /** False when another application holds the shortcut. */
  registerShortcut(accelerator: string): boolean;
  unregisterShortcut(accelerator: string): void;
  setLoginItem(openAtLogin: boolean): void;
  onChange(snapshot: SettingsSnapshot): void;
}

/** The settings and their effects on the system (shortcut, login item); the Holo follows `onChange`. */
export class SettingsController {
  readonly #store: SettingsPersistence;
  readonly #ports: SettingsPorts;
  #settings: Settings;
  #shortcutActive = false;

  constructor(store: SettingsPersistence, ports: SettingsPorts) {
    this.#store = store;
    this.#ports = ports;
    this.#settings = store.load();
  }

  get snapshot(): SettingsSnapshot {
    return { settings: this.#settings, shortcutActive: this.#shortcutActive };
  }

  /** Registers the saved shortcut; another app may already hold it (reported in the snapshot). */
  start(): void {
    this.#shortcutActive = this.#ports.registerShortcut(this.#settings.shortcut);
  }

  update(patch: SettingsPatch): SettingsUpdateResult {
    const next: Settings = { ...this.#settings };
    if (patch.shortcut !== undefined && (patch.shortcut !== next.shortcut || !this.#shortcutActive)) {
      if (!this.#ports.registerShortcut(patch.shortcut)) {
        return { ok: false, reason: "shortcut_unavailable", snapshot: this.snapshot };
      }
      if (this.#shortcutActive && patch.shortcut !== next.shortcut) this.#ports.unregisterShortcut(next.shortcut);
      this.#shortcutActive = true;
      next.shortcut = patch.shortcut;
    }
    if (patch.launchAtStartup !== undefined && patch.launchAtStartup !== next.launchAtStartup) {
      this.#ports.setLoginItem(patch.launchAtStartup);
      next.launchAtStartup = patch.launchAtStartup;
    }
    if (patch.showHolo !== undefined) next.showHolo = patch.showHolo;
    this.#commit(next);
    return { ok: true, snapshot: this.snapshot };
  }

  setHoloAnchor(anchor: Point): void {
    this.#commit({ ...this.#settings, holoAnchor: anchor });
  }

  #commit(next: Settings): void {
    this.#store.save(next);
    this.#settings = next;
    this.#ports.onChange(this.snapshot);
  }
}
