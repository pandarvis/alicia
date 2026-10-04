import { describe, expect, test } from "vitest";
import { FailureLimiter } from "../src/server/failure-limiter.ts";
import { createTestClock } from "./helpers.ts";

function setup(maxKeys = 100) {
  const time = createTestClock();
  const limiter = new FailureLimiter({ clock: time.clock, windowMs: 60_000, maxFailures: 3, maxKeys });
  return { time, limiter };
}

describe("FailureLimiter", () => {
  test("blocks a key after too many recent failures, and only that key", () => {
    const { limiter } = setup();
    for (let i = 0; i < 2; i++) limiter.fail("10.0.0.1");
    expect(limiter.blocked("10.0.0.1")).toBe(false);
    limiter.fail("10.0.0.1");
    expect(limiter.blocked("10.0.0.1")).toBe(true);
    expect(limiter.blocked("10.0.0.2")).toBe(false);
  });

  test("failures older than the window are forgotten", () => {
    const { time, limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.fail("10.0.0.1");
    time.advance(60_000);
    expect(limiter.blocked("10.0.0.1")).toBe(false);
  });

  test("memory stays bounded: the key that failed least recently is dropped first", () => {
    const { limiter } = setup(2);
    for (let i = 0; i < 3; i++) limiter.fail("a");
    limiter.fail("b");
    limiter.fail("c");
    expect(limiter.blocked("a")).toBe(false);
  });
});
