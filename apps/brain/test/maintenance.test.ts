import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function setup(options: { blockBackups?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), "alicia-maintenance-"));
  const db = openDb(join(dir, "alicia.db"));
  opened.push(db);
  syncPeople(db, [KEVIN]);
  const backupDir = join(dir, "backups");
  // A file where the directory should be: every backup fails.
  if (options.blockBackups === true) writeFileSync(backupDir, "");
  const time = createTestClock(Date.UTC(2026, 9, 4, 0, 30)); // 02:30 in Paris (summer time)
  const repository = new ConversationRepository(db, time.clock);
  const intervals: { ms: number; run: () => void; stopped: boolean }[] = [];
  const logs: string[] = [];
  const maintenance = new Maintenance({
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
  });
  return { db, time, repository, maintenance, intervals, logs, backups: () => listBackups(backupDir) };
}

describe("localTime", () => {
  test("day and hour in the household's time zone", () => {
    expect(localTime(Date.UTC(2026, 9, 4, 0, 30), "Europe/Paris")).toEqual({ day: "2026-10-04", hour: 2 });
    expect(localTime(Date.UTC(2026, 9, 3, 22, 30), "Europe/Paris")).toEqual({ day: "2026-10-04", hour: 0 });
    expect(localTime(Date.UTC(2027, 0, 3, 2, 30), "Europe/Paris")).toEqual({ day: "2027-01-03", hour: 3 });
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

  test("a failure is logged, never thrown", async () => {
    const { time, maintenance, logs } = setup({ blockBackups: true });
    time.advance(HOUR);
    await maintenance.tick();
    expect(logs.some((m) => m.startsWith("Maintenance nocturne échouée"))).toBe(true);
  });
});
