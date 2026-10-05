import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { listBackups } from "../src/db/backup.ts";
import { type Db, openDb } from "../src/db/open.ts";
import { turnLog } from "../src/db/schema.ts";
import { syncPeople } from "../src/identity/people.ts";
import { localTime, Maintenance } from "../src/maintenance.ts";
import { createTestClock, KEVIN } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dir: string | undefined;
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function setup(options: { blockBackups?: boolean; start?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "alicia-maintenance-"));
  const db = openDb(join(dir, "alicia.db"));
  opened.push(db);
  syncPeople(db, [KEVIN]);
  const backupDir = join(dir, "backups");
  // A file where the directory should be: every backup fails.
  if (options.blockBackups === true) writeFileSync(backupDir, "");
  // Default: 02:30 in Paris (summer time).
  const time = createTestClock(options.start ?? Date.UTC(2026, 9, 4, 0, 30));
  const repository = new ConversationRepository(db, time.clock);
  const intervals: { ms: number; run: () => void; stopped: boolean }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const purges: number[] = [];
  const maintenance = new Maintenance({
    attachments: {
      purgePending: () => {
        purges.push(1);
        return 2;
      },
    },
    sqlite: db.$client,
    repository,
    backupDir,
    timezone: "Europe/Paris",
    clock: time.clock,
    every: (run, ms) => {
      const interval = { ms, run, stopped: false };
      intervals.push(interval);
      return () => {
        interval.stopped = true;
      };
    },
    log: (message) => {
      logs.push(message);
    },
    logError: (message) => {
      errors.push(message);
    },
  });
  return { db, time, repository, maintenance, intervals, logs, errors, purges, backups: () => listBackups(backupDir) };
}

describe("localTime", () => {
  test("day and hour in the household's time zone", () => {
    expect(localTime(Date.UTC(2026, 9, 4, 0, 30), "Europe/Paris")).toEqual({ day: "2026-10-04", hour: 2 });
    expect(localTime(Date.UTC(2026, 9, 3, 22, 30), "Europe/Paris")).toEqual({ day: "2026-10-04", hour: 0 });
    expect(localTime(Date.UTC(2027, 0, 3, 2, 30), "Europe/Paris")).toEqual({ day: "2027-01-03", hour: 3 });
  });

  test("daylight saving days", () => {
    // 2027-03-28: 02:00 jumps to 03:00.
    expect(localTime(Date.UTC(2027, 2, 28, 0, 30), "Europe/Paris")).toEqual({ day: "2027-03-28", hour: 1 });
    expect(localTime(Date.UTC(2027, 2, 28, 1, 0), "Europe/Paris")).toEqual({ day: "2027-03-28", hour: 3 });
    // 2026-10-25: 03:00 falls back to 02:00, so 02:xx happens twice.
    expect(localTime(Date.UTC(2026, 9, 25, 0, 30), "Europe/Paris")).toEqual({ day: "2026-10-25", hour: 2 });
    expect(localTime(Date.UTC(2026, 9, 25, 1, 30), "Europe/Paris")).toEqual({ day: "2026-10-25", hour: 2 });
    expect(localTime(Date.UTC(2026, 9, 25, 2, 0), "Europe/Paris")).toEqual({ day: "2026-10-25", hour: 3 });
  });
});

describe("Maintenance", () => {
  test("once per local day, from 3:00", async () => {
    const { time, maintenance, backups } = setup();
    await maintenance.tick();
    expect(backups()).toEqual([]);
    time.advance(HOUR); // 03:30
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    time.advance(HOUR); // 04:30: already done today
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    time.advance(DAY - 2 * HOUR); // next day, 02:30
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    time.advance(HOUR);
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db", "alicia-2026-10-05.db"]);
  });

  test("the nightly job rotates the turn log", async () => {
    const { db, time, repository, maintenance } = setup();
    const c = repository.create("kevin", "Vieille");
    repository.logTurn({
      conversationId: c.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    });
    time.advance(91 * DAY);
    await maintenance.runNow();
    expect(db.select().from(turnLog).all()).toEqual([]);
  });

  test("the nightly job drops the uploads never sent", async () => {
    const { maintenance, purges, logs } = setup();
    await maintenance.runNow();
    expect(purges).toEqual([1]);
    expect(logs.at(-1)).toContain("2 pièces jointes jamais envoyées supprimées");
  });

  test("start catches up at once, then ticks every hour; stop ends it", async () => {
    const { time, maintenance, intervals, backups } = setup();
    time.advance(HOUR); // 03:30: the brain was off at 3:00
    await maintenance.start();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    expect(intervals.map((i) => i.ms)).toEqual([HOUR]);
    await maintenance.stop();
    expect(intervals[0]?.stopped).toBe(true);
  });

  test("concurrent ticks share a single run", async () => {
    const { time, maintenance } = setup();
    time.advance(HOUR);
    const first = maintenance.tick();
    expect(maintenance.tick()).toBe(first);
    await first;
  });

  test("a failure is logged as an error, never thrown", async () => {
    const { time, maintenance, logs, errors } = setup({ blockBackups: true });
    time.advance(HOUR);
    await maintenance.tick();
    expect(errors.some((m) => m.startsWith("Maintenance nocturne échouée"))).toBe(true);
    expect(logs).toEqual([]);
  });

  test("spring forward (2027-03-28): the job runs once, at 03:xx", async () => {
    const { time, maintenance, backups } = setup({ start: Date.UTC(2027, 2, 27, 23, 30) }); // 00:30
    await maintenance.tick();
    time.advance(HOUR); // 01:30
    await maintenance.tick();
    expect(backups()).toEqual([]);
    time.advance(HOUR); // 03:30 (02:xx does not exist that night)
    await maintenance.tick();
    time.advance(HOUR);
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2027-03-28.db"]);
  });

  test("fall back (2026-10-25): the twice-lived 02:xx does not run it; it runs once from 03:00", async () => {
    const { time, maintenance, backups } = setup({ start: Date.UTC(2026, 9, 25, 0, 30) }); // 02:30 summer time
    await maintenance.tick();
    time.advance(HOUR); // 02:30 again, winter time
    await maintenance.tick();
    expect(backups()).toEqual([]);
    time.advance(HOUR); // 03:30
    await maintenance.tick();
    time.advance(HOUR);
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-25.db"]);
  });

  test("a manual run before 3:00 counts for that night", async () => {
    const { time, maintenance, backups } = setup(); // 02:30
    await maintenance.runNow();
    time.advance(HOUR); // 03:30
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
  });

  test("stop waits for a running backup", async () => {
    const { time, maintenance, backups } = setup();
    time.advance(HOUR);
    void maintenance.tick();
    await maintenance.stop();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
  });

  test("the backup just written is kept even when later-dated ones exist (clock set back)", async () => {
    const { time, maintenance, backups } = setup();
    time.advance(HOUR);
    for (let day = 10; day <= 23; day++) {
      await maintenance.runNow();
      renameSync(join(dir ?? "", "backups", "alicia-2026-10-04.db"), join(dir ?? "", "backups", `alicia-2026-11-${day}.db`));
    }
    await maintenance.runNow();
    expect(backups()).toHaveLength(14);
    expect(backups()[0]).toBe("alicia-2026-10-04.db");
  });
});
