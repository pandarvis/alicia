import {
  captureShortcut, DEFAULT_SHORTCUT, type KeyboardLayout, type KeyLike, SHORTCUT_REFUSAL_MESSAGES,
} from "../../../shared/accelerator.ts";
import {
  SETTINGS_UPDATE_MESSAGES, type SettingsPatch, type SettingsSnapshot, type SettingsUpdateResult,
} from "../../../shared/settings.ts";
import { mirror } from "./mirror.ts";

/** What the screen needs from the main process (window.alicia.settings; a fake in tests). */
export interface SettingsPorts {
  get(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
  onChange(listener: (snapshot: SettingsSnapshot) => void): () => void;
  /** Sets the global shortcut aside while a new one is typed (true), or brings it back (false). */
  suspendShortcut(suspended: boolean): Promise<void>;
}

export const SETTINGS_MESSAGES = {
  ...SETTINGS_UPDATE_MESSAGES,
  ...SHORTCUT_REFUSAL_MESSAGES,
  failed: "Impossible d'enregistrer ce réglage pour l'instant.",
} as const;

const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta"]);

/** State of the Réglages screen: settings owned by the main process, edited here. */
export class SettingsScreen {
  snapshot = $state<SettingsSnapshot | null>(null);
  /** Waiting for the new shortcut on the keyboard. */
  capturing = $state(false);
  saving = $state(false);
  /** Why the shortcut could not be captured or changed (shown under its row). */
  shortcutError = $state<string | null>(null);
  /** Why another setting could not be changed. */
  error = $state<string | null>(null);

  readonly #ports: SettingsPorts;
  readonly #readLayout: () => Promise<KeyboardLayout | undefined>;
  /** The keyboard layout, read again for each capture (the person may switch layouts). */
  #layout: Promise<KeyboardLayout | undefined> = Promise.resolve(undefined);
  #off: (() => void) | null = null;

  constructor(ports: SettingsPorts, readLayout: () => Promise<KeyboardLayout | undefined> = () => Promise.resolve(undefined)) {
    this.#ports = ports;
    this.#readLayout = readLayout;
  }

  start(): void {
    this.#off ??= mirror(
      () => this.#ports.get(),
      (listener) => this.#ports.onChange(listener),
      (snapshot) => {
        this.snapshot = snapshot;
      },
    );
  }

  stop(): void {
    this.cancelCapture();
    this.#off?.();
    this.#off = null;
  }

  toggleStartup(): Promise<void> {
    const current = this.snapshot;
    return current === null ? Promise.resolve() : this.#update({ launchAtStartup: !current.settings.launchAtStartup });
  }

  toggleHolo(): Promise<void> {
    const current = this.snapshot;
    return current === null ? Promise.resolve() : this.#update({ showHolo: !current.settings.showHolo });
  }

  startCapture(): void {
    this.error = null;
    this.shortcutError = null;
    this.capturing = true;
    this.#layout = this.#readLayout().catch(() => undefined);
    // Pressing the current shortcut must be captured, not open Spotlight.
    this.#ports.suspendShortcut(true).catch(() => undefined);
  }

  cancelCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.shortcutError = null;
    void this.#resume();
  }

  /** A key pressed while capturing: Escape cancels, modifiers alone wait for the key, anything else is tried. */
  async captureKey(key: KeyLike): Promise<void> {
    if (!this.capturing) return;
    const bare = !key.ctrlKey && !key.altKey && !key.shiftKey && !key.metaKey;
    if (key.key === "Escape" && bare) {
      this.cancelCapture();
      return;
    }
    if (MODIFIER_KEYS.has(key.key)) return;
    const layout = await this.#layout;
    // Cancelled (Escape, focus lost) while the layout was read.
    if (!this.#isCapturing()) return;
    const capture = captureShortcut(key, layout);
    if (!capture.ok) {
      this.shortcutError = SETTINGS_MESSAGES[capture.reason];
      return;
    }
    this.capturing = false;
    // The main process brings the current shortcut back before registering the new one.
    await this.#resume();
    await this.#update({ shortcut: capture.accelerator });
  }

  resetShortcut(): Promise<void> {
    return this.#update({ shortcut: DEFAULT_SHORTCUT });
  }

  #resume(): Promise<void> {
    return this.#ports.suspendShortcut(false).catch(() => undefined);
  }

  /** Read through a call: `capturing` may change while `captureKey` waits. */
  #isCapturing(): boolean {
    return this.capturing;
  }

  async #update(patch: SettingsPatch): Promise<void> {
    this.saving = true;
    this.error = null;
    this.shortcutError = null;
    const fail = (message: string): void => {
      if (patch.shortcut !== undefined) this.shortcutError = message;
      else this.error = message;
    };
    try {
      const result = await this.#ports.update(patch);
      this.snapshot = result.snapshot;
      if (!result.ok) fail(SETTINGS_MESSAGES[result.reason]);
    } catch {
      fail(SETTINGS_MESSAGES.failed);
    } finally {
      this.saving = false;
    }
  }
}
