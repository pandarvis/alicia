import { describe, expect, test, vi } from "vitest";
import { mirror } from "../src/renderer/src/lib/mirror.ts";

function source<T>() {
  const listeners: ((value: T) => void)[] = [];
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const loaded = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    load: () => loaded,
    subscribe: (listener: (value: T) => void) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
    push: (value: T) => { for (const listener of [...listeners]) listener(value); },
    resolve, reject, listeners,
  };
}

describe("mirror", () => {
  test("applies the loaded value, then every push", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.resolve("a");
    await vi.waitFor(() => { expect(seen).toEqual(["a"]); });
    s.push("b");
    expect(seen).toEqual(["a", "b"]);
  });

  test("a push before the load wins over the older loaded value", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.push("fresh");
    s.resolve("stale");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["fresh"]);
  });

  test("returns the unsubscribe; a failed load is ignored", async () => {
    const s = source<string>();
    const off = mirror(s.load, s.subscribe, () => undefined);
    s.reject(new Error("down"));
    await Promise.resolve();
    off();
    expect(s.listeners).toHaveLength(0);
  });
});
