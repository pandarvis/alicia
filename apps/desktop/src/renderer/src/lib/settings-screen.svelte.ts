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
    this.capturing = true;
    this.#layout = this.#readLayout().catch(() => undefined);
  }

  cancelCapture(): void {
    this.capturing = false;
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
      this.error = SETTINGS_MESSAGES[capture.reason];
      return;
    }
    this.capturing = false;
    await this.#update({ shortcut: capture.accelerator });
  }

  resetShortcut(): Promise<void> {
    return this.#update({ shortcut: DEFAULT_SHORTCUT });
  }

  /** Read through a call: `capturing` may change while `captureKey` waits. */
  #isCapturing(): boolean {
    return this.capturing;
  }

  async #update(patch: SettingsPatch): Promise<void> {
    this.saving = true;
    this.error = null;
    try {
      const result = await this.#ports.update(patch);
      this.snapshot = result.snapshot;
      if (!result.ok) this.error = SETTINGS_MESSAGES[result.reason];
    } catch {
      this.error = SETTINGS_MESSAGES.failed;
    } finally {
      this.saving = false;
    }
  }
}
