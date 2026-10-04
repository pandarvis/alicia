import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { backupDatabase, backupFileName, listBackups, pruneBackups } from "../src/db/backup.ts";
import { type Db, openDb } from "../src/db/open.ts";
import { syncPeople } from "../src/identity/people.ts";
import { ELODIE, KEVIN } from "./helpers.ts";

let dir: string | undefined;
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function liveDb(): { db: Db; backups: string } {
  dir = mkdtempSync(join(tmpdir(), "alicia-backup-"));
  const db = openDb(join(dir, "alicia.db"));
  opened.push(db);
  return { db, backups: join(dir, "backups") };
}

function peopleIn(path: string): unknown[] {
  const copy = new Database(path, { readonly: true });
  try {
    return copy.prepare("SELECT id FROM people ORDER BY id").pluck().all();
  } finally {
    copy.close();
  }
}

describe("backupDatabase", () => {
  test("copies the live database under the day's name", async () => {
    const { db, backups } = liveDb();
    syncPeople(db, [KEVIN, ELODIE]);
    const path = await backupDatabase(db.$client, backups, "2026-10-04");
    expect(path).toBe(join(backups, "alicia-2026-10-04.db"));
    expect(readdirSync(backups)).toEqual(["alicia-2026-10-04.db"]);
    expect(peopleIn(path)).toEqual(["elodie", "kevin"]);
  });

  test("a second backup the same day replaces the first; leftovers of an interrupted one are cleaned", async () => {
    const { db, backups } = liveDb();
    mkdirSync(backups);
    writeFileSync(join(backups, "alicia-2026-10-03.db.partial"), "junk");
    syncPeople(db, [KEVIN]);
    await backupDatabase(db.$client, backups, "2026-10-04");
    syncPeople(db, [KEVIN, ELODIE]);
    const path = await backupDatabase(db.$client, backups, "2026-10-04");
    expect(readdirSync(backups)).toEqual(["alicia-2026-10-04.db"]);
    expect(peopleIn(path)).toEqual(["elodie", "kevin"]);
  });
});

describe("pruneBackups", () => {
  test("keeps the 14 most recent backups and touches nothing else", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-backup-"));
    for (let day = 1; day <= 16; day++) {
      writeFileSync(join(dir, backupFileName(`2026-09-${String(day).padStart(2, "0")}`)), "");
    }
    writeFileSync(join(dir, "notes.txt"), "");
    expect(pruneBackups(dir)).toEqual(["alicia-2026-09-01.db", "alicia-2026-09-02.db"]);
    expect(listBackups(dir)).toHaveLength(14);
    expect(listBackups(dir)[0]).toBe("alicia-2026-09-03.db");
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  test("no backup directory yet: nothing to list or prune", () => {
    expect(listBackups(join(tmpdir(), "alicia-no-such-dir"))).toEqual([]);
    expect(pruneBackups(join(tmpdir(), "alicia-no-such-dir"))).toEqual([]);
  });
});
