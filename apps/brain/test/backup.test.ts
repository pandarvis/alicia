import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

  test("only the leftovers of interrupted backups are cleaned", async () => {
    const { db, backups } = liveDb();
    mkdirSync(backups);
    for (const name of [
      "alicia-2026-10-03.db.4242.partial",
      "alicia-2026-10-03.db.4242.partial-journal",
      "alicia-2026-10-03.db.partial-journal",
      "notes.partial",
    ]) {
      writeFileSync(join(backups, name), "junk");
    }
    await backupDatabase(db.$client, backups, "2026-10-04");
    expect(readdirSync(backups).sort()).toEqual(["alicia-2026-10-04.db", "notes.partial"]);
  });

  test("a leftover that cannot be removed does not fail the backup", async () => {
    const { db, backups } = liveDb();
    // A directory under a leftover's name: removing it as a file fails.
    mkdirSync(join(backups, "alicia-2026-10-03.db.partial"), { recursive: true });
    const path = await backupDatabase(db.$client, backups, "2026-10-04");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(backups, "alicia-2026-10-03.db.partial"))).toBe(true);
  });

  test("a busy file during the final rename is retried", async () => {
    const { db, backups } = liveDb();
    let calls = 0;
    const rename = (from: string, to: string): void => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("resource busy"), { code: calls === 1 ? "EBUSY" : "EPERM" });
      renameSync(from, to);
    };
    const path = await backupDatabase(db.$client, backups, "2026-10-04", { rename, retryDelayMs: 0 });
    expect(calls).toBe(3);
    expect(readdirSync(backups)).toEqual(["alicia-2026-10-04.db"]);
    expect(existsSync(path)).toBe(true);
  });

  test("a rename that keeps failing gives up after 3 tries, without leaving its partial file", async () => {
    const { db, backups } = liveDb();
    let calls = 0;
    const rename = (): void => {
      calls++;
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    await expect(backupDatabase(db.$client, backups, "2026-10-04", { rename, retryDelayMs: 0 })).rejects.toThrow(
      /not permitted/,
    );
    expect(calls).toBe(3);
    expect(readdirSync(backups)).toEqual([]);
  });

  test("another rename error is not retried", async () => {
    const { db, backups } = liveDb();
    let calls = 0;
    const rename = (): void => {
      calls++;
      throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    };
    await expect(backupDatabase(db.$client, backups, "2026-10-04", { rename, retryDelayMs: 0 })).rejects.toThrow();
    expect(calls).toBe(1);
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

  test("the backup just written is never pruned, even when later-dated ones exist (clock set back)", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-backup-"));
    for (let day = 10; day <= 23; day++) writeFileSync(join(dir, backupFileName(`2026-09-${day}`)), "");
    writeFileSync(join(dir, backupFileName("2026-09-01")), "");
    expect(pruneBackups(dir, "alicia-2026-09-01.db")).toEqual(["alicia-2026-09-10.db"]);
    expect(listBackups(dir)).toHaveLength(14);
    expect(listBackups(dir)[0]).toBe("alicia-2026-09-01.db");
  });

  test("no backup directory yet: nothing to list or prune", () => {
    expect(listBackups(join(tmpdir(), "alicia-no-such-dir"))).toEqual([]);
    expect(pruneBackups(join(tmpdir(), "alicia-no-such-dir"))).toEqual([]);
  });
});
