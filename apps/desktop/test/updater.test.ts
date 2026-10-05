import { describe, expect, test, vi } from "vitest";
import {
  CHECK_EVERY_MS, isNothingPublished, progressPercent, type UpdateEngine, UpdateController, updateFeedUrl,
} from "../src/main/updater.ts";
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

  test("installing twice (double click) starts the installer once", () => {
    const { controller, counts, emit } = setup();
    controller.setServer(SERVER);
    emit({ state: "ready", version: "0.2.0" });
    controller.install();
    controller.install();
    expect(counts.installs).toBe(1);
  });

  test("an install that fails (error) leaves the downloaded version ready, to be tried again", () => {
    const { controller, counts, emit } = setup();
    controller.setServer(SERVER);
    emit({ state: "ready", version: "0.2.0" });
    controller.install();
    emit({ state: "error" });
    expect(controller.status).toEqual({ state: "ready", version: "0.2.0" });
    controller.install();
    expect(counts.installs).toBe(2);
  });

  test("pairing again while a version is ready keeps it, without checking again", () => {
    const { controller, counts, emit } = setup();
    controller.setServer(SERVER);
    emit({ state: "ready", version: "0.2.0" });
    controller.setServer("http://192.168.1.30:8780");
    expect(controller.status).toEqual({ state: "ready", version: "0.2.0" });
    expect(counts.checks).toBe(1);
  });

  test("signed out, what electron-updater still says is ignored", () => {
    const { controller, emit, statuses } = setup();
    controller.setServer(SERVER);
    controller.setServer(null);
    const announced = statuses.length;
    emit({ state: "ready", version: "0.2.0" });
    expect(controller.status).toEqual({ state: "disabled" });
    expect(statuses).toHaveLength(announced);
  });

  test("after a failed check, the brain coming back online is checked at once", async () => {
    const { controller, counts, failNextCheck, timers } = setup();
    failNextCheck();
    controller.setServer(SERVER);
    await vi.waitFor(() => { expect(controller.status).toEqual({ state: "error" }); });
    controller.brainReachable();
    expect(counts.checks).toBe(2);
    expect(timers[0]?.cancelled).toBe(true);
    controller.brainReachable();
    expect(counts.checks).toBe(2);
  });

  test("no version published yet on the brain (no latest.yml) is not a failure", () => {
    expect(isNothingPublished(Object.assign(new Error("Cannot find channel"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }))).toBe(true);
    expect(isNothingPublished(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isNothingPublished(new Error("boom"))).toBe(false);
    expect(isNothingPublished("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")).toBe(false);
  });

  test("download progress is a whole percentage between 0 and 100", () => {
    expect([progressPercent(42.6), progressPercent(-3), progressPercent(100.4), progressPercent(Number.NaN)]).toEqual([43, 0, 100, 0]);
  });

  test("a failed check shows as an error", async () => {
    const { controller, failNextCheck } = setup();
    failNextCheck();
    controller.setServer(SERVER);
    await vi.waitFor(() => { expect(controller.status).toEqual({ state: "error" }); });
  });
});
