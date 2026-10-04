import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./open.ts";

/** Spec, « Déploiement » : 14 backups kept. */
export const BACKUP_KEEP = 14;

const BACKUP_FILE = /^alicia-\d{4}-\d{2}-\d{2}\.db$/;
const PARTIAL_SUFFIX = ".partial";

/** `day` is a local date, YYYY-MM-DD: names sort in chronological order. */
export function backupFileName(day: string): string {
  return `alicia-${day}.db`;
}

/**
 * Copies the live database with SQLite's online backup API (consistent while the brain keeps writing,
 * copied page by page without blocking the event loop for long), into a temporary file renamed at the
 * end: a backup file is either complete or absent. Replaces the same day's backup. Returns its path.
 */
export async function backupDatabase(sqlite: Db["$client"], dir: string, day: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(PARTIAL_SUFFIX)) rmSync(join(dir, name), { force: true });
  }
  const target = join(dir, backupFileName(day));
  const partial = `${target}${PARTIAL_SUFFIX}`;
  await sqlite.backup(partial);
  renameSync(partial, target);
  return target;
}

/** Backup file names, oldest first. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort((a, b) => a.localeCompare(b));
}

/** Keeps the most recent backups (not "the last 14 days": a brain switched off for weeks keeps its copies). */
export function pruneBackups(dir: string, keep: number = BACKUP_KEEP): string[] {
  const all = listBackups(dir);
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
