import { describe, expect, test } from "vitest";
import {
  clampAnchor, defaultAnchor, HOLO_SIZE, holoAnchor, holoLayout, nearestWorkArea, spotlightBounds,
} from "../src/main/layout.ts";

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

describe("Holo layout", () => {
  test("starts in the bottom-right corner, clear of the taskbar", () => {
    expect(defaultAnchor(SCREEN)).toEqual({ x: 1760, y: 864 });
  });

  test("stays on screen", () => {
    expect(clampAnchor({ x: -50, y: 2000 }, SCREEN)).toEqual({ x: 0, y: 1040 - HOLO_SIZE.height });
    expect(clampAnchor({ x: 1900.6, y: 10.2 }, SCREEN)).toEqual({ x: 1920 - HOLO_SIZE.width, y: 10 });
  });

  test("collapsed: just the mascot", () => {
    expect(holoLayout({ x: 1760, y: 864 }, false, SCREEN)).toEqual({
      bounds: { x: 1760, y: 864, width: 136, height: 152 }, panelSide: "left", mascot: { x: 0, y: 0 },
    });
  });

  test("expanded: the mini-chat opens on the left, the mascot does not move on screen", () => {
    expect(holoLayout({ x: 1760, y: 864 }, true, SCREEN)).toEqual({
      bounds: { x: 1432, y: 596, width: 464, height: 420 }, panelSide: "left", mascot: { x: 328, y: 268 },
    });
  });

  test("near the left edge, the mini-chat opens on the right", () => {
    expect(holoLayout({ x: 100, y: 864 }, true, SCREEN)).toEqual({
      bounds: { x: 100, y: 596, width: 464, height: 420 }, panelSide: "right", mascot: { x: 0, y: 268 },
    });
  });

  test("near the top, the window stays on screen and the mascot keeps its place", () => {
    expect(holoLayout({ x: 1760, y: 50 }, true, SCREEN)).toMatchObject({ bounds: { y: 0 }, mascot: { y: 50 } });
  });

  test("on a screen too narrow for either side, the expanded window stays on screen, beside the mascot", () => {
    const narrow = { x: 0, y: 0, width: 600, height: 1040 };
    expect(holoLayout({ x: 200, y: 864 }, true, narrow)).toEqual({
      bounds: { x: 136, y: 596, width: 464, height: 420 }, panelSide: "right", mascot: { x: 0, y: 268 },
    });
  });

  test("on a second screen", () => {
    const right = { x: 1920, y: 0, width: 2560, height: 1400 };
    expect(holoLayout(defaultAnchor(right), false, right).bounds.x).toBeGreaterThan(1920);
  });
});

describe("Holo layout on several monitors", () => {
  const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };

  test("on a monitor left of the main one (negative coordinates), expanded like anywhere else", () => {
    expect(defaultAnchor(LEFT)).toEqual({ x: -160, y: 864 });
    expect(holoLayout({ x: -160, y: 864 }, true, LEFT)).toEqual({
      bounds: { x: -488, y: 596, width: 464, height: 420 }, panelSide: "left", mascot: { x: 328, y: 268 },
    });
    expect(holoLayout({ x: -1900, y: 864 }, true, LEFT)).toMatchObject({ bounds: { x: -1900 }, panelSide: "right" });
  });

  test("the work area of a point: the monitor it is on, else the nearest one", () => {
    expect(nearestWorkArea({ x: -500, y: 300 }, [SCREEN, LEFT], SCREEN)).toBe(LEFT);
    expect(nearestWorkArea({ x: 2500, y: 300 }, [SCREEN, LEFT], SCREEN)).toBe(SCREEN);
    expect(nearestWorkArea({ x: 0, y: 0 }, [], SCREEN)).toBe(SCREEN);
  });

  test("a saved place on a monitor that is gone comes back onto the nearest one", () => {
    expect(holoAnchor({ x: 3000, y: 200 }, [SCREEN], SCREEN)).toEqual({ x: 1920 - HOLO_SIZE.width, y: 200 });
    expect(holoAnchor({ x: -400, y: 300 }, [SCREEN, LEFT], SCREEN)).toEqual({ x: -400, y: 300 });
    expect(holoAnchor(null, [SCREEN, LEFT], SCREEN)).toEqual(defaultAnchor(SCREEN));
  });
});

describe("spotlightBounds", () => {
  test("centred, a little above the middle of the screen", () => {
    expect(spotlightBounds(SCREEN)).toEqual({ x: 620, y: 229, width: 680, height: 120 });
  });

  test("narrower than the screen it is on, with a margin", () => {
    expect(spotlightBounds({ x: 100, y: 0, width: 600, height: 800 })).toEqual({ x: 116, y: 176, width: 568, height: 120 });
  });
});
