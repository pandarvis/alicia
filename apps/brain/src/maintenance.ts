import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Clock } from "./clock.ts";
import type { ConversationRepository } from "./conversations/repository.ts";
import { backupDatabase, backupFileName, pruneBackups } from "./db/backup.ts";
import type { Db } from "./db/open.ts";

const HOUR_MS = 3_600_000;
/** Local hour from which the nightly job may run. */
export const NIGHTLY_HOUR = 3;

export interface MaintenanceOptions {
  sqlite: Db["$client"];
  repository: ConversationRepository;
  /** `<dataDir>/backups`. */
  backupDir: string;
  /** The household's time zone (config `timezone`): "nightly" and backup names follow it. */
  timezone: string;
  clock: Clock;
  /** Repeats `run` every `ms`; returns a stop function (default: an unref'd setInterval). */
  every?: (run: () => void, ms: number) => () => void;
  log?: (message: string) => void;
  /** Failures (default: console.error). */
  logError?: (message: string) => void;
}

const everyInterval = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};

/** Local calendar day (YYYY-MM-DD) and hour (0-23) of an instant in a time zone. */
export function localTime(ms: number, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

/**
 * The brain's nightly job: turn log rotation (90 days), then a backup of the database (14 kept).
 * Checked every hour; runs once per local day, at the first tick from 3:00. Today's backup file is the
 * proof it ran, so a restart does not run it twice, and a brain that was off at 3:00 catches up. A manual
 * run (`alicia backup`) before 3:00 writes that file too, so it counts for that night.
 */
export class Maintenance {
  readonly #sqlite: Db["$client"];
  readonly #repository: ConversationRepository;
  readonly #backupDir: string;
  readonly #timezone: string;
  readonly #clock: Clock;
  readonly #every: (run: () => void, ms: number) => () => void;
  readonly #log: (message: string) => void;
  readonly #logError: (message: string) => void;
  #stopTimer: (() => void) | undefined;
  #running: Promise<void> | undefined;

  constructor(options: MaintenanceOptions) {
    this.#sqlite = options.sqlite;
    this.#repository = options.repository;
    this.#backupDir = options.backupDir;
    this.#timezone = options.timezone;
    this.#clock = options.clock;
    this.#every = options.every ?? everyInterval;
    this.#log = options.log ?? ((message) => {
      console.log(message);
    });
    this.#logError = options.logError ?? ((message) => {
      console.error(message);
    });
  }

  /** Starts the hourly check; resolves once the catch-up tick is done. */
  start(): Promise<void> {
    this.#stopTimer ??= this.#every(() => {
      void this.tick();
    }, HOUR_MS);
    return this.tick();
  }

  /** Stops the hourly check and waits for a running job (the database must not close under a backup). */
  async stop(): Promise<void> {
    this.#stopTimer?.();
    this.#stopTimer = undefined;
    await this.#running;
  }

  /** Runs the nightly job if it is due. Never rejects; concurrent calls share the same run. */
  tick(): Promise<void> {
    this.#running ??= this.#tickOnce().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Rotation, backup of the day (replacing today's if any) and pruning, now. Returns the backup path. */
  async runNow(): Promise<string> {
    const purged = this.#repository.purgeTurnLog();
    const { day } = localTime(this.#clock(), this.#timezone);
    const path = await backupDatabase(this.#sqlite, this.#backupDir, day);
    const removed = pruneBackups(this.#backupDir, basename(path));
    this.#log(
      `Sauvegarde écrite : ${path} (journal : ${purged} entrées de plus de 90 jours supprimées ; ${removed.length} anciennes sauvegardes supprimées).`,
    );
    return path;
  }

  async #tickOnce(): Promise<void> {
    try {
      const { day, hour } = localTime(this.#clock(), this.#timezone);
      if (hour < NIGHTLY_HOUR || existsSync(join(this.#backupDir, backupFileName(day)))) return;
      await this.runNow();
    } catch (error) {
      this.#logError(`Maintenance nocturne échouée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
