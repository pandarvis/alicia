import { afterEach, describe, expect, test, vi } from "vitest";
import { motion, scrollBehavior } from "../src/renderer/src/lib/motion.ts";

// svelte/motion reads window.matchMedia, which Node lacks: the media query is replaced by a switch.
const reducedMotion = vi.hoisted(() => ({ current: false }));
vi.mock("svelte/motion", () => ({ prefersReducedMotion: reducedMotion }));

describe("motion", () => {
  afterEach(() => {
    reducedMotion.current = false;
  });

  test("keeps the duration and smooth scrolling by default", () => {
    expect(motion(180)).toBe(180);
    expect(scrollBehavior()).toBe("smooth");
  });

  test("drops to zero and instant scrolling when reduced motion is preferred", () => {
    reducedMotion.current = true;
    expect(motion(180)).toBe(0);
    expect(scrollBehavior()).toBe("auto");
  });
});
