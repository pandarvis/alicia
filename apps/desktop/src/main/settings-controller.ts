import type { Point } from "../shared/holo.ts";
import type { Settings, SettingsPatch, SettingsSnapshot, SettingsUpdateResult } from "../shared/settings.ts";

export interface SettingsPersistence {
  load(): Settings;
  /** Throws when the settings cannot be written. */
  save(settings: Settings): void;
}

export interface SettingsPorts {
  /** False when another application holds the shortcut. */
  registerShortcut(accelerator: string): boolean;
  unregisterShortcut(accelerator: string): void;
  setLoginItem(openAtLogin: boolean): void;
  /** Whether Windows starts the app at login; null when it cannot tell (a dev build has no login item). */
  isLoginItemEnabled(): boolean | null;
  onChange(snapshot: SettingsSnapshot): void;
}

/** The settings and their effects on the system (shortcut, login item); the Holo follows `onChange`. */
export class SettingsController {
  readonly #store: SettingsPersistence;
  readonly #ports: SettingsPorts;
  #settings: Settings;
  #shortcutActive = false;
  /** The shortcut is set aside while the Réglages screen captures a new one. */
  #suspended = false;

  constructor(store: SettingsPersistence, ports: SettingsPorts) {
    this.#store = store;
    this.#ports = ports;
    this.#settings = store.load();
  }

  get snapshot(): SettingsSnapshot {
    return { settings: this.#settings, shortcutActive: this.#shortcutActive };
  }

  /**
   * Registers the saved shortcut (another app may already hold it: reported in the snapshot) and reads the login
   * item back from Windows, which wins: the person may have turned it off in Windows's startup apps, and the app
   * must not turn it on again behind their back. Only `update` ever writes the login item. Never throws.
   */
  start(): void {
    this.#shortcutActive = this.#ports.registerShortcut(this.#settings.shortcut);
    const launchAtStartup = this.#ports.isLoginItemEnabled();
    if (launchAtStartup === null || launchAtStartup === this.#settings.launchAtStartup) return;
    this.#settings = { ...this.#settings, launchAtStartup };
    try {
      this.#store.save(this.#settings);
    } catch (error) {
      console.error("login item state could not be saved", error);
    }
    this.#ports.onChange(this.snapshot);
  }

  /**
   * Applies a patch all-or-nothing: the new shortcut is registered first (the step that may be refused), then
   * the settings are saved, and only then is the old shortcut freed and the login item changed. When the save
   * fails, the new shortcut is freed again and nothing has changed.
   */
  update(patch: SettingsPatch): SettingsUpdateResult {
    this.resumeShortcut();
    const previous = this.#settings;
    const next: Settings = { ...previous };
    let registered: string | null = null;
    if (patch.shortcut !== undefined && (patch.shortcut !== previous.shortcut || !this.#shortcutActive)) {
      if (!this.#ports.registerShortcut(patch.shortcut)) {
        return { ok: false, reason: "shortcut_unavailable", snapshot: this.snapshot };
      }
      registered = patch.shortcut;
      next.shortcut = patch.shortcut;
    }
    if (patch.launchAtStartup !== undefined) next.launchAtStartup = patch.launchAtStartup;
    if (patch.showHolo !== undefined) next.showHolo = patch.showHolo;

    try {
      this.#store.save(next);
    } catch (error) {
      console.error("settings could not be saved", error);
      if (registered === previous.shortcut) {
        // The saved shortcut, retried: it is registered now, and still the one on disk.
        this.#shortcutActive = true;
      } else if (registered !== null) {
        this.#ports.unregisterShortcut(registered);
      }
      return { ok: false, reason: "save_failed", snapshot: this.snapshot };
    }

    // Saved: memory follows the disk before anything else can fail.
    this.#settings = next;
    if (registered !== null) {
      const releasePrevious = this.#shortcutActive && registered !== previous.shortcut;
      this.#shortcutActive = true;
      if (releasePrevious) {
        this.#safely("old shortcut could not be released", () => {
          this.#ports.unregisterShortcut(previous.shortcut);
        });
      }
    }
    if (next.launchAtStartup !== previous.launchAtStartup) {
      this.#safely("login item could not be changed", () => {
        this.#ports.setLoginItem(next.launchAtStartup);
      });
    }
    this.#ports.onChange(this.snapshot);
    return { ok: true, snapshot: this.snapshot };
  }

  /** The Réglages screen captures a new shortcut: the current one must not open Spotlight meanwhile. */
  suspendShortcut(): void {
    if (this.#suspended) return;
    this.#suspended = true;
    if (this.#shortcutActive) this.#ports.unregisterShortcut(this.#settings.shortcut);
  }

  /** The capture ended (or a change arrives): the current shortcut is registered again. */
  resumeShortcut(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    if (!this.#shortcutActive) return;
    this.#shortcutActive = this.#ports.registerShortcut(this.#settings.shortcut);
    // Another application took it meanwhile: the screen says so.
    if (!this.#shortcutActive) this.#ports.onChange(this.snapshot);
  }

  /** A system side effect that fails after the save is logged; the saved settings stand. */
  #safely(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(what, error);
    }
  }

  /** The Holo was moved: it stays there for this session even if the position cannot be saved. Never throws. */
  setHoloAnchor(anchor: Point): void {
    this.#settings = { ...this.#settings, holoAnchor: anchor };
    try {
      this.#store.save(this.#settings);
    } catch (error) {
      console.error("Holo position could not be saved", error);
    }
    this.#ports.onChange(this.snapshot);
  }
}
