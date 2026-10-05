import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../shared/updates.ts";

/** What the controller needs from electron-updater (a fake in tests). */
export interface UpdateEngine {
  setFeed(url: string): void;
  check(): Promise<void>;
  install(): void;
  subscribe(listener: (status: UpdateStatus) => void): void;
}

export const CHECK_EVERY_MS = 6 * 3_600_000;

/** The brain serves the published versions under /updates/ (apps/brain/src/server/server.ts). */
export function updateFeedUrl(serverUrl: string): string {
  return `${serverUrl}/updates/`;
}

/** Automatic updates from the paired brain: checked at startup and every 6 hours, installed on quit or on demand. */
export class UpdateController {
  readonly #engine: UpdateEngine | null;
  readonly #schedule: (run: () => void, ms: number) => () => void;
  readonly #onStatus: (status: UpdateStatus) => void;
  #status: UpdateStatus = { state: "disabled" };
  #cancelCheck: (() => void) | null = null;

  /** `engine` is null in a development build. */
  constructor(
    engine: UpdateEngine | null,
    schedule: (run: () => void, ms: number) => () => void,
    onStatus: (status: UpdateStatus) => void,
  ) {
    this.#engine = engine;
    this.#schedule = schedule;
    this.#onStatus = onStatus;
    engine?.subscribe((status) => {
      this.#set(status);
    });
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  /** Paired with a brain (or signed out: null). */
  setServer(serverUrl: string | null): void {
    this.#cancelCheck?.();
    this.#cancelCheck = null;
    if (this.#engine === null) return;
    if (serverUrl === null) {
      this.#set({ state: "disabled" });
      return;
    }
    this.#engine.setFeed(updateFeedUrl(serverUrl));
    this.#set({ state: "idle" });
    this.#check();
  }

  /** Alicia is quitting: no more checks (nothing announced, the windows are closing). */
  stop(): void {
    this.#cancelCheck?.();
    this.#cancelCheck = null;
  }

  /** Restarts into the downloaded version (otherwise it installs when Alicia quits). */
  install(): void {
    if (this.#status.state === "ready") this.#engine?.install();
  }

  #check(): void {
    const engine = this.#engine;
    if (engine === null || this.#status.state === "ready") return;
    void engine.check().catch(() => {
      this.#set({ state: "error" });
    });
    this.#cancelCheck = this.#schedule(() => {
      this.#cancelCheck = null;
      this.#check();
    }, CHECK_EVERY_MS);
  }

  #set(status: UpdateStatus): void {
    this.#status = status;
    this.#onStatus(status);
  }
}

/**
 * electron-updater with a generic provider; the feed (the paired brain) is set at run time. Installed app only.
 * `beforeInstall` runs the app's quit path (windows allowed to close, connection and OS released) first.
 */
export function electronUpdateEngine(options: { beforeInstall: () => void }): UpdateEngine {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  return {
    setFeed: (url) => {
      autoUpdater.setFeedURL({ provider: "generic", url });
    },
    check: async () => {
      await autoUpdater.checkForUpdates();
    },
    install: () => {
      // quitAndInstall closes the windows before `before-quit`: let them really close, and clean up first.
      options.beforeInstall();
      autoUpdater.quitAndInstall();
    },
    subscribe: (listener) => {
      autoUpdater.on("checking-for-update", () => {
        listener({ state: "checking" });
      });
      autoUpdater.on("update-not-available", () => {
        listener({ state: "up_to_date" });
      });
      autoUpdater.on("update-available", () => {
        listener({ state: "downloading", percent: 0 });
      });
      autoUpdater.on("download-progress", (progress) => {
        listener({ state: "downloading", percent: Math.round(progress.percent) });
      });
      autoUpdater.on("update-downloaded", (event) => {
        listener({ state: "ready", version: event.version });
      });
      autoUpdater.on("error", () => {
        listener({ state: "error" });
      });
    },
  };
}
