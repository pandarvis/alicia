import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { onPageReset } from "../src/main/page-reset.ts";

function setup() {
  const contents = new EventEmitter();
  let resets = 0;
  onPageReset(contents, () => {
    resets++;
  });
  return { contents, resets: () => resets };
}

describe("onPageReset", () => {
  test("a main-frame navigation (reload) resets the page", () => {
    const { contents, resets } = setup();
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "file:///index.html" });
    expect(resets()).toBe(1);
  });

  test("a frame or same-document navigation does not", () => {
    const { contents, resets } = setup();
    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false, url: "x" });
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true, url: "#a" });
    contents.emit("did-start-navigation", "not details");
    expect(resets()).toBe(0);
  });

  test("a crashed or destroyed page resets", () => {
    const { contents, resets } = setup();
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    contents.emit("destroyed");
    expect(resets()).toBe(2);
  });

  test("a failing reset handler never throws into Electron", () => {
    const contents = new EventEmitter();
    onPageReset(contents, () => {
      throw new Error("boom");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => contents.emit("destroyed")).not.toThrow();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
