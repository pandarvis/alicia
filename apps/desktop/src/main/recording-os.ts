import { z } from "zod";
import type { NotificationRequest, OsIntegration, TrayHandle } from "./os-integration.ts";
import { TrayAction, type TrayItem } from "./tray-menu.ts";

/** Where the end-to-end test finds the recorder (`globalThis[TEST_HOOKS_KEY]`, read through app.evaluate). */
export const TEST_HOOKS_KEY = "__aliciaTest";

/** What the test can read back. */
export const RecordedState = z.object({
  shortcuts: z.array(z.string()),
  loginItem: z.boolean().nullable(),
  notifications: z.array(z.object({ title: z.string(), body: z.string() })),
  tray: z.array(z.object({ id: TrayAction.or(z.literal("separator")), label: z.string(), checked: z.boolean().nullable() })),
});
export type RecordedState = z.infer<typeof RecordedState>;

export interface TestHooks {
  state(): RecordedState;
  /** Another application now holds this accelerator: registering it fails. */
  occupy(accelerator: string): void;
  triggerShortcut(): void;
  clickNotification(index: number): void;
  trayAction(id: string): void;
  /** A left click on the tray icon. */
  trayClick(): void;
}

interface RecordedTray {
  items: readonly TrayItem[];
  onAction: (action: TrayAction) => void;
  onClick: () => void;
}

/** Stand-in for the OS in tests: nothing leaves the app, everything is recorded and can be triggered. */
export class RecordingOs implements OsIntegration {
  readonly #shortcuts = new Map<string, () => void>();
  readonly #occupied = new Set<string>();
  readonly #notifications: NotificationRequest[] = [];
  #loginItem: boolean | null = null;
  #tray: RecordedTray | null = null;

  registerShortcut(accelerator: string, run: () => void): boolean {
    if (this.#occupied.has(accelerator)) return false;
    this.#shortcuts.set(accelerator, run);
    return true;
  }

  unregisterShortcut(accelerator: string): void {
    this.#shortcuts.delete(accelerator);
  }

  setLoginItem(openAtLogin: boolean): void {
    this.#loginItem = openAtLogin;
  }

  notify(request: NotificationRequest): void {
    this.#notifications.push(request);
  }

  createTray(items: readonly TrayItem[], onAction: (action: TrayAction) => void, onClick: () => void): TrayHandle {
    const tray: RecordedTray = { items, onAction, onClick };
    this.#tray = tray;
    return {
      update: (next) => {
        tray.items = next;
      },
    };
  }

  dispose(): void {
    this.#shortcuts.clear();
    this.#tray = null;
  }

  #requireTray(): RecordedTray {
    if (this.#tray === null) throw new Error("No tray");
    return this.#tray;
  }

  hooks(): TestHooks {
    return {
      state: () => ({
        shortcuts: [...this.#shortcuts.keys()],
        loginItem: this.#loginItem,
        notifications: this.#notifications.map(({ title, body }) => ({ title, body })),
        tray: (this.#tray?.items ?? [])
          .filter((item) => item.id !== "separator")
          .map((item) => ({ id: item.id, label: item.label, checked: item.checked })),
      }),
      occupy: (accelerator) => {
        this.#occupied.add(accelerator);
      },
      triggerShortcut: () => {
        const [run] = this.#shortcuts.values();
        if (run === undefined) throw new Error("No shortcut registered");
        run();
      },
      clickNotification: (index) => {
        const notification = this.#notifications[index];
        if (notification === undefined) throw new Error(`No notification #${index}`);
        notification.onClick();
      },
      trayAction: (id) => {
        this.#requireTray().onAction(TrayAction.parse(id));
      },
      trayClick: () => {
        this.#requireTray().onClick();
      },
    };
  }
}
