import { afterEach, describe, expect, test, vi } from "vitest";
import { mirror } from "../src/renderer/src/lib/mirror.ts";

/** Lets pending promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function source<T>() {
  const listeners: ((value: T) => void)[] = [];
  const loads: { resolve: (value: T) => void; reject: (error: Error) => void }[] = [];
  return {
    load: () => new Promise<T>((resolve, reject) => {
      loads.push({ resolve, reject });
    }),
    subscribe: (listener: (value: T) => void) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
    push: (value: T) => { for (const listener of [...listeners]) listener(value); },
    loads, listeners,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mirror", () => {
  test("applies the loaded value, then every push", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.loads[0]?.resolve("a");
    await flush();
    expect(seen).toEqual(["a"]);
    s.push("b");
    expect(seen).toEqual(["a", "b"]);
  });

  test("a push before the load wins over the older loaded value", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.push("fresh");
    s.loads[0]?.resolve("stale");
    await flush();
    expect(seen).toEqual(["fresh"]);
  });

  test("a failed load is tried once more", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.loads[0]?.reject(new Error("main process busy"));
    await flush();
    expect(s.loads).toHaveLength(2);
    s.loads[1]?.resolve("a");
    await flush();
    expect(seen).toEqual(["a"]);
  });

  test("failing twice is logged; pushes still arrive; the unsubscribe is returned", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = source<string>();
    const seen: string[] = [];
    const off = mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.loads[0]?.reject(new Error("down"));
    await flush();
    s.loads[1]?.reject(new Error("still down"));
    await flush();
    expect(s.loads).toHaveLength(2);
    expect(logged).toHaveBeenCalledOnce();
    s.push("later");
    expect(seen).toEqual(["later"]);
    off();
    expect(s.listeners).toHaveLength(0);
  });

  test("no retry once a push arrived", async () => {
    const s = source<string>();
    mirror(s.load, s.subscribe, () => undefined);
    s.push("fresh");
    s.loads[0]?.reject(new Error("down"));
    await flush();
    expect(s.loads).toHaveLength(1);
  });
});
