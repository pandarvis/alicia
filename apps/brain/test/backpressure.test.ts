import { describe, expect, test } from "vitest";
import { type DrainOptions, waitForDrain } from "../src/server/backpressure.ts";

function fakeSocket(bufferedAmount: number) {
  return { bufferedAmount, readyState: 1, OPEN: 1 };
}

describe("waitForDrain", () => {
  test("under the high-water mark: true at once, without waiting", async () => {
    let waits = 0;
    const options: DrainOptions = { highWaterBytes: 100, timeoutMs: 1_000, pollMs: 10, wait: () => { waits++; return Promise.resolve(); } };
    expect(await waitForDrain(fakeSocket(100), options)).toBe(true);
    expect(waits).toBe(0);
  });

  test("waits while the buffer drains, then true", async () => {
    const socket = fakeSocket(300);
    const options: DrainOptions = {
      highWaterBytes: 100, timeoutMs: 1_000, pollMs: 10,
      wait: () => { socket.bufferedAmount -= 100; return Promise.resolve(); },
    };
    expect(await waitForDrain(socket, options)).toBe(true);
    expect(socket.bufferedAmount).toBe(100);
  });

  test("never drains: false after the timeout", async () => {
    let waited = 0;
    const options: DrainOptions = { highWaterBytes: 100, timeoutMs: 50, pollMs: 10, wait: (ms) => { waited += ms; return Promise.resolve(); } };
    expect(await waitForDrain(fakeSocket(1_000), options)).toBe(false);
    expect(waited).toBe(50);
  });

  test("socket closed while waiting: false", async () => {
    const socket = fakeSocket(1_000);
    const options: DrainOptions = { highWaterBytes: 100, timeoutMs: 1_000, pollMs: 10, wait: () => { socket.readyState = 3; return Promise.resolve(); } };
    expect(await waitForDrain(socket, options)).toBe(false);
  });
});
