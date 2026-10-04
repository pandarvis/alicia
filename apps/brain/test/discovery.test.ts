import { afterEach, describe, expect, test, vi } from "vitest";
import { advertiseBrain, type Publisher, type ServiceAnnouncement, SERVICE_TYPE, shouldAdvertise } from "../src/discovery.ts";

function fakePublisher(stop: () => Promise<void> = () => Promise.resolve()) {
  const published: ServiceAnnouncement[] = [];
  let stops = 0;
  const publisher: Publisher = {
    publish: (announcement) => { published.push(announcement); },
    stop: () => {
      stops++;
      return stop();
    },
  };
  return { publisher, published, stops: () => stops };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("brain discovery (mDNS)", () => {
  test("announces « Alicia sur <machine> » as _alicia._tcp, with its version", () => {
    const { publisher, published } = fakePublisher();
    advertiseBrain({ port: 8780, version: "0.1.0", hostname: "raspberrypi" }, publisher);
    expect(SERVICE_TYPE).toBe("alicia");
    expect(published).toEqual([{ name: "Alicia sur raspberrypi", type: "alicia", port: 8780, txt: { version: "0.1.0" } }]);
  });

  test("stop withdraws the announcement", async () => {
    const { publisher, stops } = fakePublisher();
    await advertiseBrain({ port: 8780, version: "0.1.0", hostname: "mac-mini" }, publisher).stop();
    expect(stops()).toBe(1);
  });

  test("a withdrawal that hangs or fails never blocks the brain's shutdown", async () => {
    vi.useFakeTimers();
    const hanging = fakePublisher(() => new Promise(() => undefined));
    const stopped = advertiseBrain({ port: 8780, version: "0.1.0", hostname: "pc" }, hanging.publisher).stop();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(stopped).resolves.toBeUndefined();
    const failing = fakePublisher(() => Promise.reject(new Error("socket closed")));
    await expect(advertiseBrain({ port: 8780, version: "0.1.0", hostname: "pc" }, failing.publisher).stop()).resolves.toBeUndefined();
  });

  test("announced only when enabled and reachable from the network", () => {
    expect(shouldAdvertise({ discovery: true, host: "0.0.0.0" })).toBe(true);
    expect(shouldAdvertise({ discovery: true, host: "192.168.1.20" })).toBe(true);
    expect(shouldAdvertise({ discovery: false, host: "0.0.0.0" })).toBe(false);
    expect(shouldAdvertise({ discovery: true, host: "127.0.0.1" })).toBe(false);
    expect(shouldAdvertise({ discovery: true, host: "localhost" })).toBe(false);
    expect(shouldAdvertise({ discovery: true, host: "::1" })).toBe(false);
  });
});
