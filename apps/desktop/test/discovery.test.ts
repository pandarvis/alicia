import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import {
  type BrainBrowser, BrainDiscovery, brainFromService, guardSocketErrors, LastSeen, STALE_MS, staticBrowser,
} from "../src/main/discovery.ts";
import type { DiscoveredBrain } from "../src/shared/discovery.ts";

const PI: DiscoveredBrain = { name: "Alicia sur pi5", url: "http://192.168.1.20:8780", version: "0.1.0" };
const MAC: DiscoveredBrain = { name: "Alicia sur mac-mini", url: "http://192.168.1.30:8780", version: null };

describe("brainFromService", () => {
  test("uses the IPv4 address the answer came from", () => {
    expect(brainFromService({
      name: "Alicia sur pi5", port: 8780, referer: { address: "192.168.1.20", family: "IPv4" },
      addresses: ["fe80::1", "192.168.1.21"], txt: { version: "0.1.0" },
    })).toEqual(PI);
  });

  test("otherwise the first usable IPv4 listed (not IPv6, not link-local)", () => {
    expect(brainFromService({
      name: "Alicia sur mac-mini", port: 8780, referer: { address: "fe80::2", family: "IPv6" },
      addresses: ["fe80::2", "169.254.3.4", "192.168.1.30"],
    })).toEqual(MAC);
  });

  test("nothing usable is ignored; a strange TXT record is not trusted", () => {
    expect(brainFromService({ name: "Alicia", port: 8780, addresses: ["fe80::2"] })).toBeNull();
    expect(brainFromService({ name: "Alicia", port: 0, addresses: ["10.0.0.5"] })).toBeNull();
    expect(brainFromService({ name: "", port: 8780, addresses: ["10.0.0.5"] })).toBeNull();
    expect(brainFromService({ name: "Alicia", port: 8780, addresses: ["10.0.0.5"], txt: { version: 42 } })?.version).toBeNull();
  });
});

function controllableBrowser() {
  let up: (brain: DiscoveredBrain) => void = () => undefined;
  let down: (name: string) => void = () => undefined;
  let starts = 0;
  let stops = 0;
  const browser: BrainBrowser = {
    start: (onUp, onDown) => {
      starts++;
      up = onUp;
      down = onDown;
      return () => { stops++; };
    },
  };
  return {
    browser,
    up: (brain: DiscoveredBrain) => { up(brain); },
    down: (name: string) => { down(name); },
    counts: () => [starts, stops],
  };
}

function manualTimers() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    runAll: () => { for (const timer of timers) if (!timer.cancelled) timer.run(); },
    delays: () => timers.map((timer) => timer.ms),
    cancelled: () => timers.map((timer) => timer.cancelled),
  };
}

describe("guardSocketErrors", () => {
  test("an mDNS socket error (port 5353 taken, refused) is reported, never thrown", () => {
    const mdns = new EventEmitter();
    const errors: unknown[] = [];
    expect(guardSocketErrors({ server: { mdns } }, (error) => { errors.push(error); })).toBe(true);
    const refused = Object.assign(new Error("bind EACCES 0.0.0.0:5353"), { code: "EACCES" });
    expect(() => mdns.emit("error", refused)).not.toThrow();
    expect(errors).toEqual([refused]);
  });

  test("an unexpected bonjour-service shape is left alone", () => {
    expect(guardSocketErrors({ server: {} }, () => undefined)).toBe(false);
    expect(guardSocketErrors(undefined, () => undefined)).toBe(false);
  });
});

describe("LastSeen", () => {
  test("names not heard from within the delay are expired, once", () => {
    const seen = new LastSeen(30_000);
    seen.seen("Alicia sur pi5", 0);
    seen.seen("Alicia sur mac-mini", 10_000);
    expect(seen.expire(30_000)).toEqual([]);
    expect(seen.expire(30_001)).toEqual(["Alicia sur pi5"]);
    expect(seen.expire(30_002)).toEqual([]);
    seen.seen("Alicia sur mac-mini", 35_000);
    expect(seen.expire(60_000)).toEqual([]);
    expect(seen.expire(65_001)).toEqual(["Alicia sur mac-mini"]);
  });

  test("a name that said goodbye is forgotten", () => {
    const seen = new LastSeen(30_000);
    seen.seen("Alicia sur pi5", 0);
    seen.forget("Alicia sur pi5");
    expect(seen.expire(100_000)).toEqual([]);
  });
});

describe("BrainDiscovery", () => {
  test("lists the brains found by name, without duplicates, and forgets those gone; an unchanged brain is no news", () => {
    const lists: string[][] = [];
    const network = controllableBrowser();
    const discovery = new BrainDiscovery(network.browser, (brains) => { lists.push(brains.map((brain) => brain.name)); });
    discovery.start();
    network.up(PI);
    network.up(MAC);
    network.up(PI);
    network.down("Alicia sur pi5");
    expect(lists).toEqual([
      ["Alicia sur pi5"],
      ["Alicia sur mac-mini", "Alicia sur pi5"],
      ["Alicia sur mac-mini"],
    ]);
    expect(discovery.brains).toEqual([MAC]);
  });

  test("one entry per brain: the same address under two names, or one name at a new address, shows once", () => {
    const network = controllableBrowser();
    const discovery = new BrainDiscovery(network.browser, () => undefined);
    discovery.start();
    network.up(PI);
    network.up({ ...PI, name: "Alicia sur pi5 (2)" });
    expect(discovery.brains).toEqual([{ ...PI, name: "Alicia sur pi5 (2)" }]);
    network.up(MAC);
    network.up({ ...MAC, url: "http://192.168.1.31:8780" });
    expect(discovery.brains.map((brain) => brain.url)).toEqual(["http://192.168.1.31:8780", "http://192.168.1.20:8780"]);
  });

  test("looking pauses while the window is hidden; shown again, the old list stays until the first answer", () => {
    const lists: DiscoveredBrain[][] = [];
    const network = controllableBrowser();
    const timers = manualTimers();
    const discovery = new BrainDiscovery(network.browser, (brains) => { lists.push(brains); }, timers.schedule);
    discovery.setVisible(false);
    discovery.start();
    expect(network.counts()).toEqual([0, 0]);
    discovery.setVisible(true);
    expect(network.counts()).toEqual([1, 0]);
    network.up(PI);
    network.up(MAC);
    discovery.setVisible(false);
    expect(network.counts()).toEqual([1, 1]);
    discovery.setVisible(true);
    expect(network.counts()).toEqual([2, 1]);
    // Never "none found" while the first query runs: the old list stays.
    expect(discovery.brains).toEqual([MAC, PI]);
    expect(lists).toEqual([[PI], [MAC, PI]]);
    // The first answer: the list starts again from what answers now.
    network.up(PI);
    expect(discovery.brains).toEqual([PI]);
    expect(lists.at(-1)).toEqual([PI]);
    timers.runAll();
    expect(discovery.brains).toEqual([PI]);
    discovery.stop();
    discovery.setVisible(false);
    discovery.setVisible(true);
    expect(network.counts()).toEqual([2, 2]);
  });

  test("shown again and nothing answers: the old list goes after the stale delay", () => {
    const lists: DiscoveredBrain[][] = [];
    const network = controllableBrowser();
    const timers = manualTimers();
    const discovery = new BrainDiscovery(network.browser, (brains) => { lists.push(brains); }, timers.schedule);
    discovery.start();
    network.up(PI);
    discovery.setVisible(false);
    discovery.setVisible(true);
    expect(discovery.brains).toEqual([PI]);
    expect(timers.delays()).toEqual([STALE_MS]);
    timers.runAll();
    expect(discovery.brains).toEqual([]);
    expect(lists).toEqual([[PI], []]);
  });

  test("hidden again before the stale delay: the delay is cancelled", () => {
    const network = controllableBrowser();
    const timers = manualTimers();
    const discovery = new BrainDiscovery(network.browser, () => undefined, timers.schedule);
    discovery.start();
    network.up(PI);
    discovery.setVisible(false);
    discovery.setVisible(true);
    discovery.setVisible(false);
    expect(timers.cancelled()).toEqual([true]);
  });

  test("start is idempotent, stop stops looking, a new search starts empty", () => {
    const network = controllableBrowser();
    const discovery = new BrainDiscovery(network.browser, () => undefined);
    discovery.start();
    discovery.start();
    network.up(PI);
    discovery.stop();
    expect(network.counts()).toEqual([1, 1]);
    discovery.start();
    expect(discovery.brains).toEqual([]);
  });

  test("the test browser announces its list at once", () => {
    const lists: DiscoveredBrain[][] = [];
    new BrainDiscovery(staticBrowser([PI]), (brains) => { lists.push(brains); }).start();
    expect(lists).toEqual([[PI]]);
  });
});
