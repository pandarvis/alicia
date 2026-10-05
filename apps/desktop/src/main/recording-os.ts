import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Point } from "../shared/holo.ts";
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
  /** The pages the app asked to open in the person's browser (none is ever opened in tests). */
  browser: z.array(z.string()),
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
  /** Puts the mouse pointer somewhere on the desktop ({ x, y }, screen DIP). */
  moveCursor(point: unknown): void;
  /** Which windows count as in front: "focused" (all), "unfocused" (none), or "real" (the OS focus). */
  pinFocus(mode: unknown): void;
}

const FocusMode = z.enum(["focused", "unfocused", "real"]);
type FocusMode = z.infer<typeof FocusMode>;

interface RecordedTray {
  items: readonly TrayItem[];
  onAction: (action: TrayAction) => void;
  onClick: () => void;
}

export interface RecordingOsOptions {
  /** Where the login item is kept between runs (in the test profile), as Windows keeps it in the registry. */
  loginItemFile?: string;
}

/** The login item kept by an earlier run; none when the file is missing or unreadable. */
function readLoginItem(file: string | undefined): boolean {
  if (file === undefined) return false;
  try {
    const parsed = z.boolean().safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success && parsed.data;
  } catch {
    return false;
  }
}

/** Stand-in for the OS in tests: nothing leaves the app, everything is recorded and can be triggered. */
export class RecordingOs implements OsIntegration {
  readonly #shortcuts = new Map<string, () => void>();
  readonly #occupied = new Set<string>();
  readonly #notifications: NotificationRequest[] = [];
  readonly #browser: string[] = [];
  readonly #loginItemFile: string | undefined;
  /** What "Windows" holds (kept in the file between runs). */
  #loginItemEnabled: boolean;
  /** What the app wrote during this run (null: nothing). */
  #loginItem: boolean | null = null;
  #tray: RecordedTray | null = null;
  #cursor: Point = { x: 0, y: 0 };
  #focus: FocusMode = "real";

  constructor(options: RecordingOsOptions = {}) {
    this.#loginItemFile = options.loginItemFile;
    this.#loginItemEnabled = readLoginItem(options.loginItemFile);
  }

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
    this.#loginItemEnabled = openAtLogin;
    if (this.#loginItemFile !== undefined) writeFileSync(this.#loginItemFile, JSON.stringify(openAtLogin));
  }

  /** Like a fresh Windows profile: no login item until the app writes one. */
  isLoginItemEnabled(): boolean {
    return this.#loginItemEnabled;
  }

  notify(request: NotificationRequest): void {
    this.#notifications.push(request);
  }

  /** Nothing opens: the test reads the URL and plays the browser itself. */
  openInBrowser(url: string): Promise<void> {
    this.#browser.push(url);
    return Promise.resolve();
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

  cursorScreenPoint(): Point {
    return this.#cursor;
  }

  isFocused(window: { isFocused(): boolean }): boolean {
    if (this.#focus === "real") return window.isFocused();
    return this.#focus === "focused";
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
        browser: [...this.#browser],
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
      moveCursor: (point) => {
        this.#cursor = Point.parse(point);
      },
      pinFocus: (mode) => {
        this.#focus = FocusMode.parse(mode);
      },
    };
  }
}
