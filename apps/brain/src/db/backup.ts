import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Db } from "./open.ts";

/** Spec, « Déploiement » : the 14 most recent backups are kept. */
export const BACKUP_KEEP = 14;

const BACKUP_FILE = /^alicia-\d{4}-\d{2}-\d{2}\.db$/;
/** Leftovers of an interrupted backup: the temporary copy (with or without a run id) and its journal. */
const PARTIAL_FILE = /^alicia-\d{4}-\d{2}-\d{2}\.db(\.\d+)?\.partial(-journal)?$/;
/** Windows may briefly lock a fresh file (antivirus, indexer): the final rename is retried. */
const RENAME_TRIES = 3;
const RENAME_RETRY_DELAY_MS = 200;
const RETRIED_RENAME_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM"]);

export interface BackupOptions {
  /** Injected by tests (default: fs.renameSync). */
  rename?: (from: string, to: string) => void;
  /** Pause between rename tries (default 200 ms). */
  retryDelayMs?: number;
}

/** `day` is a local date, YYYY-MM-DD: names sort in chronological order. */
export function backupFileName(day: string): string {
  return `alicia-${day}.db`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Best effort: a leftover that cannot be removed now (locked, odd file) must never fail the backup. */
function removeLeftovers(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!PARTIAL_FILE.test(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Left for a later run.
    }
  }
}

async function renameWithRetry(
  rename: (from: string, to: string) => void,
  from: string,
  to: string,
  delayMs: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= RENAME_TRIES || code === undefined || !RETRIED_RENAME_CODES.has(code)) throw error;
      await sleep(delayMs);
    }
  }
}

/**
 * Copies the live database with SQLite's online backup API (consistent while the brain keeps writing,
 * copied page by page without blocking the event loop for long), into a temporary file named after this
 * process and renamed at the end: a backup file is either complete or absent. Replaces the same day's
 * backup. Returns its path.
 */
export async function backupDatabase(
  sqlite: Db["$client"],
  dir: string,
  day: string,
  options: BackupOptions = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  removeLeftovers(dir);
  const target = join(dir, backupFileName(day));
  const partial = `${target}.${process.pid}.partial`;
  try {
    await sqlite.backup(partial);
    await renameWithRetry(options.rename ?? renameSync, partial, target, options.retryDelayMs ?? RENAME_RETRY_DELAY_MS);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return target;
}

/** Backup file names, oldest first. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Keeps the most recent backups (not "the last 14 days": a brain switched off for weeks keeps its copies).
 * `justWritten` is never removed, even if later-dated backups exist (clock set back). Returns the removed names.
 */
export function pruneBackups(dir: string, justWritten?: string, keep: number = BACKUP_KEEP): string[] {
  const all = listBackups(dir);
  const removable = all.filter((name) => name !== justWritten);
  const removed = removable.slice(0, Math.max(0, all.length - keep));
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
