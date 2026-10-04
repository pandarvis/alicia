import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Settings } from "../shared/settings.ts";

/** settings.json in the profile: plain JSON (nothing secret), validated field by field. */
export class SettingsStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
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

  save(settings: Settings): void {
    // Write then rename, so a crash never leaves a half-written file.
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Settings.parse(settings), null, 2));
    renameSync(temporary, this.#path);
  }
}
