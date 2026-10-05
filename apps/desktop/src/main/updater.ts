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

/** A whole percentage between 0 and 100 (electron-updater reports a float, sometimes slightly off). */
export function progressPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Automatic updates from the paired brain: checked at startup and every 6 hours, installed on quit or on demand. */
export class UpdateController {
  readonly #engine: UpdateEngine | null;
  readonly #schedule: (run: () => void, ms: number) => () => void;
  readonly #onStatus: (status: UpdateStatus) => void;
  #status: UpdateStatus = { state: "disabled" };
  #cancelCheck: (() => void) | null = null;
  /** The installer was started: a second click must not start it again. */
  #installing = false;

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
      // Signed out: what electron-updater still reports is not shown. A version it already downloaded still
      // installs when Alicia quits (autoInstallOnAppQuit): it came from the brain this PC was paired with.
      if (this.#status.state === "disabled") return;
      if (status.state === "error") this.#installing = false;
      this.#set(status);
    });
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  /** Paired with a brain (or signed out: null). */
  setServer(serverUrl: string | null): void {
    this.stop();
    if (this.#engine === null) return;
    if (serverUrl === null) {
      this.#set({ state: "disabled" });
      return;
    }
    this.#engine.setFeed(updateFeedUrl(serverUrl));
    // A version already downloaded stays ready: nothing to check until it is installed.
    if (this.#status.state === "ready") return;
    this.#set({ state: "idle" });
    this.#check();
  }

  /** The brain is reachable again: after a failed check, check now instead of waiting six hours. */
  brainReachable(): void {
    if (this.#status.state !== "error") return;
    this.stop();
    this.#set({ state: "idle" });
    this.#check();
  }

  /** Alicia is quitting: no more checks (nothing announced, the windows are closing). */
  stop(): void {
    this.#cancelCheck?.();
    this.#cancelCheck = null;
  }

  /**
   * Restarts into the downloaded version (otherwise it installs when Alicia quits). electron-updater quits the
   * app itself (app.quit: before-quit then will-quit run the app's one quit path).
   */
  install(): void {
    if (this.#status.state !== "ready" || this.#installing || this.#engine === null) return;
    this.#installing = true;
    this.#engine.install();
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

/** electron-updater with a generic provider; the feed (the paired brain) is set at run time. Installed app only. */
export function electronUpdateEngine(): UpdateEngine {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  return {
    setFeed: (url) => {
      // One range per request: Fastify's static files answer single ranges only.
      autoUpdater.setFeedURL({ provider: "generic", url, useMultipleRangeRequest: false });
    },
    check: async () => {
      const result = await autoUpdater.checkForUpdates();
      // A failed download is reported by the "error" event; its promise must not be left unhandled.
      result?.downloadPromise?.catch(() => undefined);
    },
    install: () => {
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
        listener({ state: "downloading", percent: progressPercent(progress.percent) });
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
