import { describe, expect, test } from "vitest";
import { addressKey, FailureLimiter } from "../src/server/failure-limiter.ts";
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

  test("a new failure makes a key the most recent: the other one is dropped, its own count is kept", () => {
    const { limiter } = setup(2);
    limiter.fail("a");
    limiter.fail("a");
    limiter.fail("b");
    limiter.fail("b");
    limiter.fail("a"); // "a" is now the most recent key, with 3 failures
    limiter.fail("c"); // over the limit of 2 keys: "b" goes
    expect(limiter.blocked("a")).toBe(true);
    limiter.fail("b");
    expect(limiter.blocked("b")).toBe(false);
    limiter.fail("b");
    expect(limiter.blocked("b")).toBe(false);
  });

  test("a success clears the key's failures", () => {
    const { limiter } = setup();
    limiter.fail("10.0.0.1");
    limiter.fail("10.0.0.1");
    limiter.succeed("10.0.0.1");
    limiter.fail("10.0.0.1");
    limiter.fail("10.0.0.1");
    expect(limiter.blocked("10.0.0.1")).toBe(false);
  });
});

describe("addressKey", () => {
  test.each([
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8:1:2:ffff::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002::1", "2001:db8:1:2::/64"],
    ["2001:db8:1:3::1", "2001:db8:1:3::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ])("IPv6 %s → its /64 prefix %s", (ip, key) => {
    expect(addressKey(ip)).toBe(key);
  });
  test.each(["10.0.0.1", "::ffff:10.0.0.1", "not an address"])("%s is kept as is", (ip) => {
    expect(addressKey(ip)).toBe(ip);
  });
});
