import { describe, expect, test } from "vitest";
import {
  addDays, addMinutesLocal, daysBetween, formatDay, formatDayTime, instantOfDateTime, IsoDate, localDay,
  LocalDateTime, localMidnight, normalizeLocal,
} from "../src/google/time.ts";

const PARIS = "Europe/Paris";

describe("household time", () => {
  test("local midnight, summer, winter and both DST days", () => {
    expect(localMidnight("2026-10-10", PARIS)).toBe("2026-10-09T22:00:00.000Z");
    expect(localMidnight("2026-12-10", PARIS)).toBe("2026-12-09T23:00:00.000Z");
    expect(localMidnight("2026-03-29", PARIS)).toBe("2026-03-28T23:00:00.000Z");
    expect(localMidnight("2026-10-25", PARIS)).toBe("2026-10-24T22:00:00.000Z");
  });

  test("day arithmetic", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-10-10", -1)).toBe("2026-10-09");
    expect(daysBetween("2026-10-10", "2026-10-17")).toBe(7);
    expect(normalizeLocal("2026-10-10T14:00")).toBe("2026-10-10T14:00:00");
    expect(addMinutesLocal("2026-10-10T23:30", 60)).toBe("2026-10-11T00:30:00");
  });

  test("validation", () => {
    expect(IsoDate.safeParse("2026-10-10").success).toBe(true);
    expect(IsoDate.safeParse("2026-02-30").success).toBe(false);
    expect(LocalDateTime.safeParse("2026-10-10T14:00").success).toBe(true);
    expect(LocalDateTime.safeParse("2026-10-10T14:00:30").success).toBe(true);
    for (const bad of ["2026-10-10T25:00", "2026-10-10T14:00Z", "2026-10-10T14:00+02:00", "2026-10-10"]) {
      expect(LocalDateTime.safeParse(bad).success).toBe(false);
    }
  });

  test("a wall-clock time on both DST days", () => {
    expect(instantOfDateTime("2026-03-29T10:00:00", PARIS)).toBe(Date.UTC(2026, 2, 29, 8));
    expect(instantOfDateTime("2026-10-25T10:00:00", PARIS)).toBe(Date.UTC(2026, 9, 25, 9));
    expect(localDay(Date.UTC(2026, 2, 28, 23, 30), PARIS)).toBe("2026-03-29");
  });

  test("instants and French formats", () => {
    expect(instantOfDateTime("2026-10-10T14:00:00+02:00", PARIS)).toBe(Date.UTC(2026, 9, 10, 12));
    expect(instantOfDateTime("2026-10-10T14:00:00", PARIS)).toBe(Date.UTC(2026, 9, 10, 12));
    expect(localDay(Date.UTC(2026, 9, 9, 22, 30), PARIS)).toBe("2026-10-10");
    expect(formatDay("2026-10-10")).toMatch(/^sam\.? 10 oct\.?$/);
    expect(formatDayTime(Date.UTC(2026, 9, 10, 12), PARIS)).toMatch(/sam\.? 10 oct\..*14:00/);
  });
});
