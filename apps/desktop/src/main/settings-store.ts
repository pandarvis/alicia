import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Settings, StrictSettings } from "../shared/settings.ts";

export interface SettingsStoreOptions {
  /** The rename that publishes the new file (a fake in tests). */
  rename?: (from: string, to: string) => void;
}

/** Windows reports a file briefly held by an antivirus or the indexer with these codes. */
const TRANSIENT_LOCK = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 20;

function isTransientLock(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && TRANSIENT_LOCK.has(error.code);
}

/** Blocks for a few milliseconds: saves are rare, small and synchronous. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** settings.json in the profile: plain JSON (nothing secret), validated field by field. */
export class SettingsStore {
  readonly #path: string;
  readonly #rename: (from: string, to: string) => void;

  constructor(path: string, options: SettingsStoreOptions = {}) {
    this.#path = path;
    this.#rename = options.rename ?? renameSync;
  }

  load(): Settings {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      // Missing or unreadable file: every field takes its default.
    }
    // Only an object can hold settings; anything else (a string, a list…) counts as empty.
    return Settings.parse(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {});
  }

  /** Throws when the file cannot be written; the previous file is then left untouched. */
  save(settings: Settings): void {
    // Strict: broken settings are a bug to surface, never silently replaced by defaults on disk.
    const valid = StrictSettings.parse(settings);
    // Write then rename, so a crash never leaves a half-written file.
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(valid, null, 2));
    try {
      this.#publish(temporary);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  #publish(temporary: string): void {
    for (let attempt = 1; ; attempt++) {
      try {
        this.#rename(temporary, this.#path);
        return;
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !isTransientLock(error)) throw error;
        pause(RETRY_PAUSE_MS);
      }
    }
  }
}
