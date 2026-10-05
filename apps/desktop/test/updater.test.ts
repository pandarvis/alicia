import { describe, expect, test, vi } from "vitest";
import { CHECK_EVERY_MS, type UpdateEngine, UpdateController, updateFeedUrl } from "../src/main/updater.ts";
import type { UpdateStatus } from "../src/shared/updates.ts";

function setup(withEngine = true) {
  const feeds: string[] = [];
  const counts = { checks: 0, installs: 0 };
  let failNext = false;
  let emit: (status: UpdateStatus) => void = () => undefined;
  const engine: UpdateEngine = {
    setFeed: (url) => { feeds.push(url); },
    check: () => {
      counts.checks++;
      if (!failNext) return Promise.resolve();
      failNext = false;
      return Promise.reject(new Error("brain unreachable"));
    },
    install: () => { counts.installs++; },
    subscribe: (listener) => { emit = listener; },
  };
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const statuses: UpdateStatus[] = [];
  const controller = new UpdateController(
    withEngine ? engine : null,
    (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    (status) => { statuses.push(status); },
  );
  return {
    controller, feeds, counts, timers, statuses,
    emit: (status: UpdateStatus) => { emit(status); },
    failNextCheck: () => { failNext = true; },
  };
}

const SERVER = "http://192.168.1.20:8780";

describe("UpdateController", () => {
  test("the feed is the paired brain's /updates/", () => {
    expect(updateFeedUrl(SERVER)).toBe("http://192.168.1.20:8780/updates/");
  });

  test("a dev build has no updates", () => {
    const { controller, statuses } = setup(false);
    controller.setServer(SERVER);
    expect(controller.status).toEqual({ state: "disabled" });
    expect(statuses).toEqual([]);
  });

  test("checks the paired brain now, then every 6 hours", () => {
    const { controller, feeds, counts, timers } = setup();
    controller.setServer(SERVER);
    expect(feeds).toEqual(["http://192.168.1.20:8780/updates/"]);
    expect(controller.status).toEqual({ state: "idle" });
    expect(counts.checks).toBe(1);
    expect(timers.map((timer) => timer.ms)).toEqual([CHECK_EVERY_MS]);
    timers[0]?.run();
    expect(counts.checks).toBe(2);
  });

  test("a downloaded update can be installed; periodic checks stop", () => {
    const { controller, counts, timers, emit } = setup();
    controller.setServer(SERVER);
    controller.install();
    expect(counts.installs).toBe(0);
    emit({ state: "ready", version: "0.2.0" });
    expect(controller.status).toEqual({ state: "ready", version: "0.2.0" });
    timers[0]?.run();
    expect(counts.checks).toBe(1);
    controller.install();
    expect(counts.installs).toBe(1);
  });

  test("signing out turns updates off and cancels the checks", () => {
    const { controller, timers } = setup();
    controller.setServer(SERVER);
    controller.setServer(null);
    expect(controller.status).toEqual({ state: "disabled" });
    expect(timers[0]?.cancelled).toBe(true);
  });

  test("quitting stops the checks without announcing anything", () => {
    const { controller, timers, statuses } = setup();
    controller.setServer(SERVER);
    const announced = statuses.length;
    controller.stop();
    expect(timers[0]?.cancelled).toBe(true);
    expect(statuses).toHaveLength(announced);
  });

  test("a failed check shows as an error", async () => {
    const { controller, failNextCheck } = setup();
    failNextCheck();
    controller.setServer(SERVER);
    await vi.waitFor(() => { expect(controller.status).toEqual({ state: "error" }); });
  });
});
