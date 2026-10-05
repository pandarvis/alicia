import { describe, expect, test } from "vitest";
import { GoogleApiError } from "../src/google/http.ts";
import {
  addDays, addMinutesLocal, daysBetween, formatDay, formatDayTime, instantOfDateTime, IsoDate, localDay,
  LocalDateTime, localMidnight, normalizeLocal, Rfc3339DateTime, withOffset,
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

  test("the hour skipped in spring and the hour repeated in autumn: pinned", () => {
    // 02:30 does not exist on 29 March in Paris: it lands one hour later, at 03:30 summer time.
    expect(instantOfDateTime("2026-03-29T02:30:00", PARIS)).toBe(Date.UTC(2026, 2, 29, 1, 30));
    // 02:30 happens twice on 25 October: the second one (winter time) is taken.
    expect(instantOfDateTime("2026-10-25T02:30:00", PARIS)).toBe(Date.UTC(2026, 9, 25, 1, 30));
  });

  test("a wall-clock time with the household's offset, as Google writes it back", () => {
    expect(withOffset("2026-10-12T09:00:00", PARIS)).toBe("2026-10-12T09:00:00+02:00");
    expect(withOffset("2026-12-12T09:00", PARIS)).toBe("2026-12-12T09:00:00+01:00");
    expect(withOffset("2026-12-12T09:00:00", "UTC")).toBe("2026-12-12T09:00:00Z");
    expect(withOffset("2026-12-12T09:00:00", "America/St_Johns")).toBe("2026-12-12T09:00:00-03:30");
  });

  test("RFC 3339 instants only, as Google sends them", () => {
    for (const ok of ["2026-10-10T14:00:00+02:00", "2026-10-10T12:00:00Z", "2026-10-10T12:00:00.000Z"]) {
      expect(Rfc3339DateTime.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["2026-10-10T14:00:00", "2026-10-10", "2026-02-30T10:00:00Z", "demain 14h", "2026-10-10T25:00:00Z"]) {
      expect(Rfc3339DateTime.safeParse(bad).success, bad).toBe(false);
    }
  });

  test("a malformed date is Google's data gone wrong: an 'invalid' Google failure, never a crash", () => {
    for (const run of [() => addDays("nope", 1), () => instantOfDateTime("demain", PARIS), () => formatDay("2026-13")]) {
      let failure = "";
      try {
        run();
      } catch (error) {
        failure = error instanceof GoogleApiError ? error.failure : "other";
      }
      expect(failure).toBe("invalid");
    }
  });

  test("instants and French formats", () => {
    expect(instantOfDateTime("2026-10-10T14:00:00+02:00", PARIS)).toBe(Date.UTC(2026, 9, 10, 12));
    expect(instantOfDateTime("2026-10-10T14:00:00", PARIS)).toBe(Date.UTC(2026, 9, 10, 12));
    expect(localDay(Date.UTC(2026, 9, 9, 22, 30), PARIS)).toBe("2026-10-10");
    expect(formatDay("2026-10-10")).toMatch(/^sam\.? 10 oct\.?$/);
    expect(formatDayTime(Date.UTC(2026, 9, 10, 12), PARIS)).toMatch(/sam\.? 10 oct\..*14:00/);
  });
});
